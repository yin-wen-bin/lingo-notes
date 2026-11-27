import type { FontTheme } from '../../shared/typography/theme';

export type { Example } from '../../shared/cloud-types';
import type { Example } from '../../shared/cloud-types';
export type ExplanationLanguage = 'zh' | 'ja' | 'en';
export type Lesson = {
  language: string; explanation_language?: ExplanationLanguage; summary_zh: string;
  vocabulary: { term: string; pos: string; meaning: string; reading: string; examples: Example[] }[];
  grammar: { point: string; explanation: string; examples: Example[] }[];
};
export type RecordItem = { record_id: string; revision: number; local_date: string; text: string; input_type: string; status: string; has_image?: boolean };
export type LearningRecord = RecordItem & {
  original_text?: string; corrected_text?: string; context?: string;
  source?: { title?: string; url?: string } | null;
  recognized_text?: string;
  image?: { mime_type?: string; width?: number; height?: number } | null;
  result?: Lesson | null;
};
export type ReviewState = { point_key: string; mastered: boolean; mastered_at?: string | null; review_round: number; next_due_date: string | null; completed: boolean; last_completed_at?: string | null; reviewed?: boolean; completed_at?: string | null };
export type ReviewCard = { id: string; record_id: string; slot?: number; kind?: 'vocabulary' | 'grammar'; term: string; reading?: string; pos?: string; language: string; explanation_language?: ExplanationLanguage; term_language?: ExplanationLanguage | 'mixed'; meaning: string; example: Example; local_date: string; scheduled_round?: number } & Partial<ReviewState>;
export type ReviewBatch = { id: string; local_date: string; cards: ReviewCard[]; opened_at?: string | null };
export type Settings = { review_enabled: boolean; push_enabled: boolean; review_daily_limit?: number; explanation_mode?: 'fast' | 'thinking'; explanation_language?: ExplanationLanguage; font_theme?: FontTheme };
export type KeyStatus = { configured: boolean; last_four?: string | null };
export type Notice = { text: string; tone?: 'error' | 'success' } | null;
