import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  rankNotesForQuestion,
  selectNotesWithinBudget,
  type Env,
  type EvidenceSource,
  type RankableNote,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';

/** 挑中的筆記，含快取指紋所需的雜湊。 */
export interface SelectedNote {
  id: string;
  contentHash: string;
}

export interface NoteCollection {
  /** 送進模型的來源（已排序、已套預算）。 */
  sources: EvidenceSource[];
  /**
   * 上面那些來源對應的雜湊，用來算快取指紋。
   *
   * 與 `sources` 同一次挑選的產物——分成兩支查詢會讓「依據的內容」與
   * 「快取判準」有機會對不起來，那種不一致極難察覺。
   */
  fingerprintInputs: SelectedNote[];
}

/**
 * 章節筆記來源。
 *
 * 使用者的單章 PDF 通常題目與筆記並存；筆記隨題目匯入後，成為該題庫
 * **本地且免費**的資料源——不呼叫 Tavily、不受 30 RPM 限流、沒有網路延遲，
 * 而且針對性遠高於關鍵字搜尋。
 *
 * 因此筆記**一律載入**，不由 AI 的研究規劃決定。規劃階段只需要判斷
 * 「除了筆記之外，還需不需要上網查」。把免費且精準的東西也拿去問模型
 * 該不該用，是白白多一次判斷失誤的機會。
 */
@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * 取出這一題可用的筆記，已排序並套用字元預算。
   *
   * 檢索範圍是題目所屬的**題組**：單章 PDF 匯入一次就是一個題組，
   * 同一份文件裡的筆記與題目本來就該互相看得見。
   */
  async collectForQuestion(input: {
    questionId: string;
    questionGroupId: string;
    /** 題幹與選項合併後的文字，用來做關鍵字比對。 */
    questionText: string;
  }): Promise<NoteCollection> {
    const rows = await this.database.db
      .select({
        id: schema.studyNotes.id,
        noteKey: schema.studyNotes.noteKey,
        title: schema.studyNotes.title,
        content: schema.studyNotes.content,
        keywords: schema.studyNotes.keywords,
        contentHash: schema.studyNotes.contentHash,
        sourcePage: schema.studyNotes.sourcePage,
        linkedQuestionId: schema.questionNoteLinks.questionId,
      })
      .from(schema.studyNotes)
      .leftJoin(
        schema.questionNoteLinks,
        and(
          eq(schema.questionNoteLinks.studyNoteId, schema.studyNotes.id),
          eq(schema.questionNoteLinks.questionId, input.questionId),
        ),
      )
      .where(
        and(
          eq(schema.studyNotes.questionGroupId, input.questionGroupId),
          isNull(schema.studyNotes.deletedAt),
        ),
      );

    if (rows.length === 0) return EMPTY_COLLECTION;

    const rankable: RankableNote[] = rows.map((row) => ({
      id: row.id,
      noteKey: row.noteKey,
      title: row.title,
      content: row.content,
      keywords: row.keywords,
      explicitlyLinked: row.linkedQuestionId !== null,
    }));

    const ranked = rankNotesForQuestion(rankable, input.questionText)
      // 分數為 0 代表和這一題完全沒有詞彙交集，帶進去只是稀釋脈絡。
      .filter((note) => note.score > 0)
      .slice(0, this.env.NOTES_MAX_PER_QUESTION);

    const selected = selectNotesWithinBudget(ranked, this.env.NOTES_MAX_CHARS_PER_QUESTION);
    if (selected.length === 0) return EMPTY_COLLECTION;

    const byId = new Map(rows.map((row) => [row.id, row]));
    const fetchedAt = new Date().toISOString();

    this.logger.log(
      `題目 ${input.questionId} 帶入 ${selected.length} 段筆記（候選 ${rows.length} 段）`,
    );

    return {
      sources: selected.map((note, index) => {
        const row = byId.get(note.id)!;
        return {
          // 筆記排在網頁前面，因此先佔用 S1、S2…
          sourceId: `S${index + 1}`,
          sourceType: 'note' as const,
          url: null,
          domain: null,
          title: row.title ?? `筆記 ${row.noteKey}`,
          publishedDate: null,
          fetchedAt,
          // 筆記沒有網域可判定；顯示由 sourceType 決定，這裡只是欄位需要值。
          trustTier: 'educational' as const,
          content: note.content,
          searchQuery: null,
          rank: null,
          score: null,
          studyNoteId: note.id,
        };
      }),
      fingerprintInputs: selected.map((note) => ({
        id: note.id,
        contentHash: byId.get(note.id)!.contentHash,
      })),
    };
  }
}

const EMPTY_COLLECTION: NoteCollection = { sources: [], fingerprintInputs: [] };
