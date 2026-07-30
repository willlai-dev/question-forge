'use client';

import { AppShell } from '@/components/app-shell';
import { QuestionForm } from '@/components/question-form';

export default function NewQuestionPage() {
  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">新增題目</h1>
        <QuestionForm />
      </div>
    </AppShell>
  );
}
