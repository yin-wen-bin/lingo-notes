import type { FontTheme } from '../../shared/typography/theme';

export type Example = { text: string; translation: string };
export type Lesson = {
  language: string; summary_zh: string;
  vocabulary: { term: string; pos: string; meaning: string; reading: string; examples: Example[] }[];
  grammar: { point: string; explanation: string; examples: Example[] }[];
};
export type RecordItem = { record_id: string; revision: number; local_date: string; text: string; input_type: string; status: string; has_image?: boolean };
export type LearningRecord = RecordItem & {
  original_text?: string; corrected_text?: string; context?: string;
  source?: { title?: string; url?: string } | null;
  image?: { path: string; mime_type: string; width?: number; height?: number } | null;
  result?: Lesson | null;
};
export type ReviewCard = { id: string; record_id: string; term: string; reading?: string; language: string; meaning: string; example: Example; local_date: string };
export type ReviewBatch = { id: string; local_date: string; cards: ReviewCard[]; opened_at?: string | null };
export type Settings = { review_enabled: boolean; push_enabled: boolean; explanation_mode?: 'fast' | 'thinking'; font_theme?: FontTheme };
export type KeyStatus = { configured: boolean; last_four?: string | null };
export type Notice = { text: string; tone?: 'error' | 'success' } | null;
