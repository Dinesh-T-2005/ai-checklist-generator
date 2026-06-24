import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DocumentsService } from '../documents/documents.service';
import { EncryptedCookieService } from 'src/app/services/encrypted-cookie.service';
import { LoaderComponent } from 'src/app/loader/loader.component';
import { ToastrService } from 'ngx-toastr';
import { Router } from '@angular/router';
import { JobService } from '../job/job.service';
import { catchError, concatMap, of, tap } from 'rxjs';
export interface ChecklistItem {
  id: string;
  name: string;
  category?: string;
  isMandatory?: boolean;
  orgid?: number;
  orgdiv?: number;
}

export interface ChecklistTemplate {
  templateId?: string | number;
  checklist: ChecklistItem[];
  createdAt?: string;
  templateName?: string;
  industry?: string;
  orgid?: number;
  orgdiv?: number;
  email?: string;
  RecruiterID?: number;
}


@Component({
  selector: 'app-checklist-aigenerat',
  standalone: true,
  imports: [CommonModule, FormsModule, LoaderComponent],
  templateUrl: './checklist-aigenerat.component.html',
  styleUrls: ['./checklist-aigenerat.component.scss']
})
export class ChecklistAigeneratComponent {
  userPrompt = '';
  generating = false;
  checklistTemplate: ChecklistTemplate | null = null;
  templates: ChecklistTemplate[] = [];
  saveSuccess = false;
  orgid: any;
  orgdiv: any;
  recruiterid: any;
  email: any;
  docTitle = '';
  docDescription = '';
  isLoading: boolean = false;
  showDeleteModal = false;
  pageIndex = 0;
  pageSize = 5;
  total = 0;
  paginatedTemplates: ChecklistTemplate[] = [];
  data: any;
  isDisabled = false;
  isAiFeatureActive: boolean;

  aiModalData: Array<{ label: string; used: string; available: string }> = [];
  aiModalOpen = false;
  private aiModalTimer: any = null;



  constructor(private checklistService: DocumentsService, private encryptedCookieService: EncryptedCookieService, private toastr: ToastrService, private route: Router, private Service: JobService) {
    this.orgid = this.encryptedCookieService.getCookie('orgId');
    this.orgdiv = this.encryptedCookieService.getCookie('divisionId');
    this.recruiterid = this.encryptedCookieService.getCookie('userId');
    this.email = this.encryptedCookieService.getCookie('email');
  }


  ngOnInit(): void {
    this.loadTemplates();
    this.fetchAiAccess();

    this.data = history.state;
    console.log('Received state:', this.data);

  }
  private aiButton?: {
    is_active?: boolean;
    daily_reset_enabled?: boolean;
    weekly_reset_enabled?: boolean;
    monthly_reset_enabled?: boolean;
    available_today?: number;
    available_thisweek?: number;
    available_monthly?: number;
  };
  private getNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }


  loadTemplates() {
    this.checklistService.getTemplates(this.orgdiv, this.orgid, this.recruiterid).subscribe({
      next: (res) => {
        const all = res;
        this.templates = all.slice(0, 5);
      },
      error: (err) => console.error(err)
    });
  }
  fetchAiAccess(): void {
    const payload = {
      orgId: this.orgid,
      recruiterId: this.recruiterid,
      button_id: 9,
      button_name: 'ai_checklist'
    };

    this.Service.GetAIaccess(payload).subscribe({
      next: (res: any) => {
        if (res.ok && res.button) {
          this.aiButton = res.button;
          this.updateButtonState();
        } else {
          this.isDisabled = true;
          this.toastr.error('AI Access unavailable', 'Error');
        }
      },
      error: (err: any) => {
        console.error('Error fetching AI access:', err);
        this.isDisabled = true;
        this.toastr.error('Unable to check AI quota', 'Error');
      }
    });
  }

  private updateButtonState(): void {
    if (!this.aiButton) {
      this.isDisabled = true;
      this.isAiFeatureActive = false;
      return;
    }

    const active = this.aiButton.is_active !== false;
    const dailyEnabled = !!this.aiButton.daily_reset_enabled;
    const weeklyEnabled = !!this.aiButton.weekly_reset_enabled;
    const monthlyEnabled = !!this.aiButton.monthly_reset_enabled;

    const dailyAvail = this.getNum(this.aiButton.available_today, 0);
    const weeklyAvail = this.getNum(this.aiButton.available_thisweek, 0);
    const monthlyAvail = this.getNum(this.aiButton.available_monthly, 0);

    this.isAiFeatureActive = active;
    this.isDisabled =
      !active ||
      (dailyEnabled && dailyAvail <= 0) ||
      (weeklyEnabled && weeklyAvail <= 0) ||
      (monthlyEnabled && monthlyAvail <= 0);
  }
  addItem() {
    if (!this.checklistTemplate) return;
    this.checklistTemplate.checklist.push({
      id: `${Date.now()}`,
      name: 'New Item',
      category: 'Optional',
      isMandatory: false
    });
  }

  removeItem(index: number) {
    this.checklistTemplate?.checklist.splice(index, 1);
  }

  saveTemplate() {
    this.saveSuccess = false;
    if (!this.checklistTemplate) return;

    this.checklistTemplate.createdAt = new Date().toISOString();
    this.checklistTemplate.orgid = this.orgid;
    this.checklistTemplate.orgdiv = this.orgdiv;
    this.checklistTemplate.email = this.email;
    this.checklistTemplate.RecruiterID = this.recruiterid;

    this.checklistService.saveTemplate(this.checklistTemplate).pipe(

      concatMap(() => {
        const body = {
          userId: String(this.recruiterid),
          orgId: this.orgid,
          button_id: 9,
          usedAmount: 1,
          div_id: this.orgdiv,
          extraData: JSON.stringify({
            source: 'SaveChecklist',
            count: this.checklistTemplate?.checklist?.length || 0
          })
        };

        return this.Service.LogAiButtonUsage(body).pipe(
          tap((res: any) => {
            const btn = res?.button ?? res;
            if (btn) {
              this.showAiUsageModal(btn);
            }
          }),
          catchError((err) => {
            console.error('Failed to log AI usage:', err);
            return of(null);
          })
        );
      })

    ).subscribe({

      next: () => {
        this.toastr.success('AI Document created successfully!');

        this.loadTemplates();
        this.showDeleteModal = false;
        this.saveSuccess = true;

        this.fetchAiAccess();
        setTimeout(() => {
          if (this.data.source == "onboarding") {
            this.route.navigate(['/ats/job/RecruitmentHub/Onboardingdetails']);
          } else if (this.data.source == "checklist") {
            this.route.navigate(['/ats/document/documents-checklist']);
          }
        }, 5000);
      },

      error: (err) => {
        console.error(err);
      }

    });
  }


  private showAiUsageModal(btn: any) {
    if (!btn) return;

    const rows: Array<{ label: string; used: string; available: string }> = [];

    if (btn.daily_reset_enabled) {
      rows.push({ label: 'Daily', used: `${btn.used_today}/${btn.daily_limit}`, available: String(btn.available_today) });
    }
    if (btn.weekly_reset_enabled) {
      rows.push({ label: 'Weekly', used: `${btn.used_thisweek}/${btn.weekly_limit}`, available: String(btn.available_thisweek) });
    }
    if (btn.monthly_reset_enabled) {
      rows.push({ label: 'Monthly', used: `${btn.used_monthly}/${btn.limit_monthly}`, available: String(btn.available_monthly) });
    }

    this.aiModalData = rows;
    this.aiModalOpen = true;

    this.clearAiModalTimer();
    this.aiModalTimer = setTimeout(() => this.closeAiModal(), 10_000);
  }
  closeAiModal() {
    this.aiModalOpen = false;
    this.clearAiModalTimer();
  }

  private clearAiModalTimer() {
    if (this.aiModalTimer) {
      clearTimeout(this.aiModalTimer);
      this.aiModalTimer = null;
    }
  }


  generateDocument() {
    if (!this.aiButton) {
      this.toastr.error('Unable to load AI access info', 'Error');
      return;
    }
    const active = this.aiButton.is_active !== false;
    const dailyEnabled = !!this.aiButton.daily_reset_enabled;
    const weeklyEnabled = !!this.aiButton.weekly_reset_enabled;
    const monthlyEnabled = !!this.aiButton.monthly_reset_enabled;

    const dailyAvail = this.getNum(this.aiButton.available_today, 0);
    const weeklyAvail = this.getNum(this.aiButton.available_thisweek, 0);
    const monthlyAvail = this.getNum(this.aiButton.available_monthly, 0);

    if (!active) {
      this.toastr.error('This AI feature is currently inactive for your account.', 'Feature Inactive');
      return;
    }

    if (dailyEnabled && dailyAvail <= 0) {
      this.toastr.warning('Your daily AI quota has been used up. Please try again tomorrow.', 'Quota Exceeded');
      return;
    }
    if (weeklyEnabled && weeklyAvail <= 0) {
      this.toastr.warning('Your weekly AI quota has been used up. Please try again next week.', 'Quota Exceeded');
      return;
    }
    if (monthlyEnabled && monthlyAvail <= 0) {
      this.toastr.warning('Your monthly AI quota has been exhausted.', 'Quota Exceeded');
      return;
    }

    if (!this.docTitle.trim() || !this.docDescription.trim()) return;

    this.generating = true;
    this.isLoading = true;

    const payload = {
      title: this.docTitle,
      description: this.docDescription,
    };

    this.checklistService.generateDocument(payload).subscribe({
      next: (tpl: any) => {
        this.checklistTemplate = tpl;

        if (this.checklistTemplate?.checklist) {
          this.checklistTemplate.checklist = this.checklistTemplate.checklist.map((it: any, i: number) => ({
            id: `${Date.now()}-${i}`,
            ...it
          }));
        }
        this.isLoading = false;
        this.generating = false;
        // show the generated checklist UI
        this.showDeleteModal = true;
      },
      error: (err) => {
        console.error(err);
        this.generating = false;
      }
    });
  }

  useTemplate(t: ChecklistTemplate) {
    this.checklistTemplate = t;
    this.showDeleteModal = true;
  }

  colse() {
    this.showDeleteModal = false;
  }

}
