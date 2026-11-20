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

export type Lesson = {
  language: string;
  summary_zh: string;
  vocabulary?: Array<{term: string; pos?: string; reading?: string; meaning: string; examples: Example[]}>;
  grammar?: Array<{point: string; reading?: string; explanation: string; examples: Example[]}>;
};
export type Example = { text: string; translation: string };
export type LearningRecord = {
  record_id: string;
  revision: number;
  status: 'saved' | 'processing' | 'awaiting_review' | 'complete' | 'failed' | 'interrupted' | 'cancelled';
  input_type: 'text' | 'image';
  local_date: string;
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
