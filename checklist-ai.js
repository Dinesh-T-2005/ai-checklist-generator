const express = require("express");
const router = express.Router();
const sql = require("mssql");
require("dotenv").config();

const { runAI } = require("../services/ai");


function extractJsonBlock(text) {
  if (!text) return text;

  const fenced =
    text.match(/```json([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);

  if (fenced) {
    return fenced[1].trim();
  }

  return text.trim();
}

function parseChecklistTextToItems(text) {
  if (!text) return [];
  let cleaned = extractJsonBlock(text);
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleaned = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed)) {
      return parsed.map((it) => ({
        name: it.name || it,
        description: it.description || "",
        category: it.category || "Optional",
        isMandatory: !!it.isMandatory,
      }));
    }
  } catch (e) {
    console.warn("JSON parse failed, falling back to text parsing");
  }

  return cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("{") && !line.startsWith("}"))
    .map((l) => ({
      name: l.replace(/^\d+\.?\s*/, ""),
      description: "",
      category: "Optional",
      isMandatory: false,
    }));
}

router.post("/generate", async (req, res) => {
  const { prompt, title, description } = req.body;

  const systemPrompt = `
You are an HR onboarding assistant.
ALWAYS return ONLY a JSON array of checklist items. No wrapper objects.
Each item must contain: name, description, category, isMandatory
`;

  if (prompt) {
    try {
      const userMessage = `
Generate an onboarding checklist for: ${prompt}
Return ONLY a JSON array.
`;
      const fullPrompt = `${systemPrompt}\n${userMessage}`;

      const text = await runAI("checklist_ai", fullPrompt, req.app.locals.db);

      const items = parseChecklistTextToItems(text);

      return res.json({
        templateName: `${prompt} — Suggested`,
        industry: prompt,
        checklist: items,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }
  if (title && description) {
    try {
      const userMessage = `
Title: ${title}
Description: ${description}

Generate a checklist ONLY.
Return ONLY a JSON array.
`;

      const fullPrompt = `${systemPrompt}\n${userMessage}`;

      const text = await runAI("checklist_ai", fullPrompt, req.app.locals.db);

      const items = parseChecklistTextToItems(text);

      return res.json({
        templateName: title,
        industry: "AI Document",
        checklist: items,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({
    error: "Either 'prompt' or 'title + description' is required",
  });
});


router.post("/save", async (req, res) => {
  const pool = req.app.locals.db;
  if (!pool) {
    return res.status(500).json({ error: "Database not initialized" });
  }
  const {
    templateName,
    industry,
    checklist,
    orgid,
    orgdiv,
    email,
    RecruiterID,
  } = req.body;

  if (!templateName) {
    return res.status(400).json({ error: "templateName is required" });
  }
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const templateReq = new sql.Request(tx);
    const templateResult = await templateReq
      .input("TemplateName", sql.NVarChar(255), templateName)
      .input("Industry", sql.NVarChar(255), industry || null)
      .input("CreatedBy", sql.NVarChar(255), email || null)
      .input("orgid", sql.Int, orgid)
      .input("orgdiv", sql.Int, orgdiv)
      .input("RecruiterID", sql.Int, RecruiterID).query(`
        INSERT INTO AiChecklist 
        (TemplateName, Industry, CreatedBy, orgId, orgDiv, RecruiterID)
        OUTPUT INSERTED.TemplateId
        VALUES (@TemplateName, @Industry, @CreatedBy, @orgid, @orgdiv, @RecruiterID);
      `);
    const templateId = templateResult.recordset[0].TemplateId;


    const insertedItemIds = [];

    if (Array.isArray(checklist) && checklist.length > 0) {
      for (const item of checklist) {
        const itemReq = new sql.Request(tx);
        const result = await itemReq
          .input("TemplateId", sql.Int, templateId)
          .input("Name", sql.NVarChar(255), item.name || "")
          .input("Description", sql.NVarChar(sql.MAX), item.description || "")
          .input("Category", sql.NVarChar(100), item.category || "Optional")
          .input("IsMandatory", sql.Bit, !!item.isMandatory).query(`
            INSERT INTO AIChecklistLable
            (TemplateId, Name, Description, Category, IsMandatory)
            OUTPUT INSERTED.ItemId
            VALUES (@TemplateId, @Name, @Description, @Category, @IsMandatory);
          `);

        insertedItemIds.push(result.recordset[0].ItemId);
      }
    }


    const createdReq = new sql.Request(tx);
    await createdReq
      .input("checklistName", sql.NVarChar(255), templateName)
      // .input("Checklist", sql.NVarChar(sql.MAX), JSON.stringify(checklist))
      .input("Active", sql.Bit, 1)
      .input("CreateBy", sql.NVarChar(255), email || null)
      .input("CreatedAt", sql.DateTime, new Date())
      .input("RecruiterID", sql.Int, RecruiterID)
      .input("OrgID", sql.Int, orgid)
      .input("OrgDiv", sql.Int, orgdiv)
      // .input("lastupdatedby", sql.NVarChar(255), email || null)
      // .input("lastupdatedtime", sql.DateTime, new Date())
      // .input("AdditionalChecklist", sql.NVarChar(sql.MAX), null)
      .input(
        "AIChecklist",
        sql.NVarChar(sql.MAX),
        JSON.stringify(insertedItemIds),
      ).query(`
        INSERT INTO CreatedChecklist 
        (checklistName, Active, CreateBy, CreatedAt, RecruiterID, OrgID, OrgDiv, AIChecklist)
        VALUES 
        (@checklistName, @Active, @CreateBy, @CreatedAt, @RecruiterID, @OrgID, @OrgDiv, @AIChecklist);
      `);

    await tx.commit();

    res.json({
      success: true,
      templateId,
      insertedItemIds,
      message: "Template + checklist + CreatedChecklist saved successfully",
    });
  } catch (err) {
    console.error("Save Error:", err);
    try {
      await tx.rollback();
    } catch (rb) {
      console.error("Rollback Error:", rb);
    }
    res.status(500).json({ error: err.message });
  }
});

router.get("/templates", async (req, res) => {
  const pool = req.app.locals.db;
  const { orgdiv, orgid, recruiterid } = req.query;
  if (!pool) {
    return res.status(500).json({ error: "Database not initialized" });
  }

  try {
    const result = await pool
      .request()
      .input("OrgID", sql.Int, orgid)
      .input("OrgDiv", sql.Int, orgdiv)
      .input("RecruiterID", sql.Int, recruiterid).query(`
      SELECT
        t.TemplateId,
        t.TemplateName,
        t.Industry,
        t.orgId,
        t.orgDiv,
        t.RecruiterID,
        t.CreatedBy,
        t.CreatedAt,
        i.ItemId,
        i.Name       AS ItemName,
        i.Description,
        i.Category,
        i.IsMandatory
      FROM AiChecklist t
      LEFT JOIN AIChecklistLable i
        ON t.TemplateId = i.TemplateId
        WHERE t.orgId = @OrgID AND t.orgDiv = @OrgDiv AND t.RecruiterID = @RecruiterID
      ORDER BY t.CreatedAt DESC, i.ItemId ASC;
    `);

    const rows = result.recordset;

    const templatesMap = new Map();

    for (const row of rows) {
      let template = templatesMap.get(row.TemplateId);
      if (!template) {
        template = {
          _id: row.TemplateId,
          templateName: row.TemplateName,
          industry: row.Industry,
          createdBy: row.CreatedBy,
          createdAt: row.CreatedAt,
          checklist: [],
        };
        templatesMap.set(row.TemplateId, template);
      }

      if (row.ItemId) {
        template.checklist.push({
          _id: row.ItemId,
          name: row.ItemName,
          description: row.Description,
          category: row.Category,
          isMandatory: row.IsMandatory,
        });
      }
    }

    res.json(Array.from(templatesMap.values()));
  } catch (err) {
    console.error("Templates Fetch Error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
