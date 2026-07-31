/** 前端共用的顯示文字與樣式對照。集中一處，避免同一個狀態在不同頁面翻成不同名稱。 */

export const MASTERY_LABEL: Record<string, { label: string; className: string }> = {
  active: { label: '尚未掌握', className: 'bg-destructive/10 text-destructive' },
  improving: { label: '進步中', className: 'bg-amber-100 text-amber-800' },
  mastered: { label: '已掌握', className: 'bg-emerald-100 text-emerald-800' },
};

export const QUIZ_MODE_LABEL: Record<string, string> = {
  practice: '練習',
  mistake_review: '錯題重練',
  knowledge_focus: '知識點加強',
  exam: '模擬測驗',
};

export const QUIZ_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  in_progress: { label: '進行中', className: 'bg-amber-100 text-amber-800' },
  submitted: { label: '已交卷', className: 'bg-emerald-100 text-emerald-800' },
  abandoned: { label: '已放棄', className: 'bg-muted text-muted-foreground' },
};
