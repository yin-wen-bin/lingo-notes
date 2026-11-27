import { useEffect, useRef, useState } from 'react';
import { api } from './cloud';
import type { ReviewCard, ReviewState } from './types';

export function mergeReviewState(card: ReviewCard, state: ReviewState): ReviewCard {
  if (card.point_key !== state.point_key) return card;
  // Shared point state must never overwrite a different record's card identity.
  const { mastered, mastered_at, review_round, next_due_date, completed, last_completed_at, reviewed, completed_at } = state;
  return { ...card, mastered, mastered_at, review_round, next_due_date, completed, last_completed_at,
    ...(reviewed === undefined ? {} : { reviewed }), ...(completed_at === undefined ? {} : { completed_at }) };
}

export function useReviewActions(scope: string, onError: (error: unknown) => void, onSaved: (state: ReviewState, batch?: string) => void) {
  const alive = useRef(true), activeScope = useRef(scope), locked = useRef(false), generation = useRef(0);
  const [pending, setPending] = useState<string | null>(null);
  activeScope.current = scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; locked.current = false; setPending(null); }, [scope]);

  async function act(card: ReviewCard, action: 'review.complete' | 'review.mastery', batchId?: string, mastered?: boolean): Promise<ReviewState | null> {
    if (locked.current || !card.point_key) return null;
    locked.current = true; setPending(card.point_key);
    const originalScope = scope, token = generation.current;
    const valid = () => alive.current && activeScope.current === originalScope && generation.current === token;
    try {
      const result = await api<{ card: ReviewState; reviewed?: boolean }>(action, {
        card_id: card.id, point_key: card.point_key,
        ...(action === 'review.complete' ? { batch_id: batchId } : { mastered })
      });
      const state = result?.card;
      if (state?.point_key !== card.point_key || typeof state.mastered !== 'boolean' || !Number.isInteger(state.review_round) || state.review_round < 0 || state.review_round > 5 || typeof state.completed !== 'boolean'
        || (action === 'review.mastery' && state.mastered !== mastered) || (action === 'review.complete' && (!result.reviewed || !state.reviewed))) throw new Error('REVIEW_STATE_UNCONFIRMED');
      onSaved(state, action === 'review.complete' ? batchId : undefined);
      return valid() ? state : null;
    } catch (error) { if (valid()) onError(error); return null; }
    finally { if (valid()) { locked.current = false; setPending(null); } }
  }
  return { pending, complete: (card: ReviewCard, batchId: string) => act(card, 'review.complete', batchId), mastery: (card: ReviewCard, mastered: boolean) => act(card, 'review.mastery', undefined, mastered) };
}
