export type CloudSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email?: string };
};

export type SessionStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type ExplanationLanguage = 'zh' | 'ja' | 'en';
export type Lesson = {
  language: string;
  explanation_language?: ExplanationLanguage;
  summary_zh: string;
  vocabulary?: Array<{term: string; pos?: string; reading?: string; meaning: string; examples: Example[]}>;
  grammar?: Array<{point: string; reading?: string; explanation: string; examples: Example[]}>;
};
export type Example = { text: string; translation: string };
export type ReviewPointState = {
  point_key: string;
  kind: 'vocabulary' | 'grammar';
  mastered: boolean;
  mastered_at: string | null;
  review_round: number;
  next_due_date: string | null;
  completed: boolean;
  last_completed_at?: string | null;
};
export type ReviewCard = ReviewPointState & {
  id: string;
  record_id: string;
  slot: number;
  term: string;
  reading?: string;
  pos?: string;
  language: string;
  explanation_language?: ExplanationLanguage;
  term_language?: string;
  meaning: string;
  example: Example;
  local_date: string;
  scheduled_round?: number;
  reviewed?: boolean;
  completed_at?: string | null;
};
export type LearningRecord = {
  record_id: string;
  revision: number;
  status: 'saved' | 'processing' | 'awaiting_review' | 'complete' | 'failed' | 'interrupted' | 'cancelled';
  input_type: 'text' | 'image';
  local_date: string;
  explanation_language?: ExplanationLanguage;
  original_text?: string;
  recognized_text?: string;
  corrected_text?: string;
  context?: string;
  context_meta?: { status: string };
  source?: { title: string; url: string } | null;
  image?: { sha256?: string; byte_size?: number; [key: string]: unknown } | null;
  result?: Lesson | null;
  error?: string | null;
  [key: string]: unknown;
};

export type CloudEvent = {
  type: 'accepted' | 'progress' | 'complete' | 'error';
  request_id: string;
  record_id: string;
  revision: number;
  sequence?: number;
  record?: LearningRecord;
  preview?: Partial<Lesson>;
  error?: string;
};
