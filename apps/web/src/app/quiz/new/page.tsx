'use client';

import type {
  ChapterResponse,
  KnowledgeTagResponse,
  PaginationMeta,
  QuestionGroupResponse,
  QuizSessionResponse,
  SubjectResponse,
} from '@repo/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, ErrorBanner, Field } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function NewQuizPage() {
  return (
    <AppShell>
      <NewQuizView />
    </AppShell>
  );
}

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type ScopeLevel = 'subject' | 'chapter' | 'question_group' | 'knowledge_tag';

function NewQuizView() {
  const router = useRouter();

  const [subjectId, setSubjectId] = useState('');
  // 章節可以不選（整科）、選一個，或選多個——複習常常是「第三、五、七章」這種組合。
  const [chapterIds, setChapterIds] = useState<string[]>([]);
  const [questionGroupId, setQuestionGroupId] = useState('');
  const [knowledgeTagId, setKnowledgeTagId] = useState('');
  const [orderStrategy, setOrderStrategy] = useState<'sequential' | 'random'>('sequential');
  const [shuffleOptions, setShuffleOptions] = useState(false);
  const [revealMode, setRevealMode] = useState<'immediate' | 'after_submit'>('immediate');
  const [allowAnswerChange, setAllowAnswerChange] = useState(true);
  const [onlyMistakes, setOnlyMistakes] = useState(false);
  const [questionLimit, setQuestionLimit] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const chapters = useQuery({
    queryKey: ['chapters', subjectId],
    queryFn: () => api.get<ChapterResponse[]>(`/subjects/${subjectId}/chapters`),
    enabled: subjectId !== '',
  });

  // 選了多個章節時就不再依章節收斂題組清單——後端一次只吃一個 chapterId，
  // 硬挑一個來過濾會讓清單看起來像漏了東西。
  const soleChapterId = chapterIds.length === 1 ? chapterIds[0]! : '';

  const groups = useQuery({
    queryKey: ['question-groups', subjectId, soleChapterId],
    queryFn: () => {
      const params = new URLSearchParams({ pageSize: '100' });
      if (subjectId) params.set('subjectId', subjectId);
      if (soleChapterId) params.set('chapterId', soleChapterId);
      return api.get<{ items: QuestionGroupResponse[]; pagination: PaginationMeta }>(
        `/question-groups?${params}`,
      );
    },
    enabled: subjectId !== '',
  });

  const knowledgeTags = useQuery({
    queryKey: ['knowledge-tags', 'active'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100&status=active',
      ),
  });

  /**
   * 只送出最細的那一層範圍。
   * 同時送出科目與其下的題組會讓範圍取聯集，等於整個科目都出題 ——
   * 使用者選了題組卻拿到整科的題目，是最容易被誤會的錯誤。
   * 知識點是另一個維度，選了就以它為準（FR-QUIZ-06）。
   *
   * 同一層之內則是聯集：勾了三個章節就送三筆 chapter，
   * 後端對同型範圍取 OR，等於「這三章的題目」。
   */
  const scopes: { scopeType: ScopeLevel; refId: string }[] = knowledgeTagId
    ? [{ scopeType: 'knowledge_tag', refId: knowledgeTagId }]
    : questionGroupId
      ? [{ scopeType: 'question_group', refId: questionGroupId }]
      : chapterIds.length > 0
        ? chapterIds.map((refId) => ({ scopeType: 'chapter' as const, refId }))
        : subjectId
          ? [{ scopeType: 'subject', refId: subjectId }]
          : [];

  const create = useMutation({
    mutationFn: () =>
      api.post<QuizSessionResponse>('/quiz-sessions', {
        mode: onlyMistakes ? 'mistake_review' : 'practice',
        scopes,
        orderStrategy,
        shuffleOptions,
        questionLimit: questionLimit === '' ? null : Number(questionLimit),
        revealMode,
        allowAnswerChange,
        onlyMistakes,
      }),
    onSuccess: (session) => router.push(`/quiz/${session.id}`),
  });

  const error = create.error instanceof ApiRequestError ? create.error : null;
  const canStart = scopes.length > 0 || onlyMistakes;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">開始作答</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          選擇出題範圍與作答方式，判分完全由程式執行。
        </p>
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      <Card className="space-y-4">
        <h2 className="font-medium">出題範圍</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="科目">
            <select
              className={selectClass}
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setChapterIds([]);
                setQuestionGroupId('');
              }}
            >
              <option value="">請選擇</option>
              {subjects.data?.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}（{subject.questionCount} 題）
                </option>
              ))}
            </select>
          </Field>

          {/*
            章節用核取方塊而不是下拉：下拉一次只能表達一章，
            而「第三、五、七章一起複習」是很常見的需求。
            都不勾＝整個科目，勾一個＝單章，勾多個＝這幾章的聯集。
          */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">章節</span>
              {chapterIds.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                  onClick={() => setChapterIds([])}
                >
                  清除（已選 {chapterIds.length}）
                </button>
              )}
            </div>
            <div
              className={`max-h-40 overflow-y-auto rounded-md border border-input bg-background p-2 ${
                subjectId ? '' : 'opacity-50'
              }`}
            >
              {!subjectId ? (
                <p className="text-sm text-muted-foreground">請先選擇科目</p>
              ) : chapters.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">此科目沒有章節</p>
              ) : (
                chapters.data?.map((chapter) => (
                  <label
                    key={chapter.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={chapterIds.includes(chapter.id)}
                      onChange={(e) => {
                        setChapterIds((prev) =>
                          e.target.checked
                            ? [...prev, chapter.id]
                            : prev.filter((id) => id !== chapter.id),
                        );
                        // 題組屬於單一章節，換章節時原本選的那個多半已經不在範圍內。
                        setQuestionGroupId('');
                      }}
                    />
                    <span className="truncate">{chapter.name}</span>
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {chapterIds.length === 0 ? '不勾選則涵蓋整個科目' : `已選 ${chapterIds.length} 個章節`}
            </p>
          </div>

          <Field
            label="題組"
            hint={
              chapterIds.length > 1
                ? '選了多個章節時不能再限定單一題組'
                : '不選則涵蓋上一層全部'
            }
          >
            <select
              className={selectClass}
              value={questionGroupId}
              // 題組隸屬單一章節，和「多個章節」是互相矛盾的範圍。
              disabled={!subjectId || chapterIds.length > 1}
              onChange={(e) => setQuestionGroupId(e.target.value)}
            >
              <option value="">全部題組</option>
              {groups.data?.items.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}（{group.questionCount} 題）
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="或只作答特定知識點" hint="選了知識點就以它為準，忽略上方的科目／章節／題組">
          <select
            className={selectClass}
            value={knowledgeTagId}
            onChange={(e) => setKnowledgeTagId(e.target.value)}
          >
            <option value="">不依知識點篩選</option>
            {knowledgeTags.data?.items.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
                {tag.subjectName ? `（${tag.subjectName}）` : ''}．{tag.usageCount} 題
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyMistakes}
            onChange={(e) => setOnlyMistakes(e.target.checked)}
          />
          只作答錯題（與上方範圍取交集；不選範圍則涵蓋整本錯題本）
        </label>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">作答方式</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="出題順序">
            <select
              className={selectClass}
              value={orderStrategy}
              onChange={(e) => setOrderStrategy(e.target.value as typeof orderStrategy)}
            >
              <option value="sequential">依題庫順序</option>
              <option value="random">隨機</option>
            </select>
          </Field>

          <Field label="答案顯示時機">
            <select
              className={selectClass}
              value={revealMode}
              onChange={(e) => setRevealMode(e.target.value as typeof revealMode)}
            >
              <option value="immediate">作答後立即顯示</option>
              <option value="after_submit">交卷後才顯示</option>
            </select>
          </Field>

          <Field label="題數上限" hint="留空表示全部">
            <input
              type="number"
              min={1}
              className={selectClass}
              value={questionLimit}
              onChange={(e) => setQuestionLimit(e.target.value)}
              placeholder="全部"
            />
          </Field>
        </div>

        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={shuffleOptions}
              onChange={(e) => setShuffleOptions(e.target.checked)}
            />
            隨機排列選項順序
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allowAnswerChange}
              onChange={(e) => setAllowAnswerChange(e.target.checked)}
            />
            允許修改已作答的答案
          </label>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button disabled={!canStart || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? '出題中…' : '開始作答'}
        </Button>
        {!canStart && (
          <span className="text-sm text-muted-foreground">請先選擇科目，或勾選「只作答錯題」</span>
        )}
      </div>
    </div>
  );
}
