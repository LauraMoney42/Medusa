import { useCallback, useRef } from 'react';

/**
 * Returns a transcript handler for MicButton that inserts progressive dictation
 * (interim + final) into a text input.
 *
 * Each interim/final result from the mic is the FULL transcription of the
 * current utterance, so on every update we replace the dictated tail rather
 * than appending — otherwise interim results would stack up as duplicates.
 * The text present when a dictation session began is captured as the "base"
 * and preserved, so dictating never clobbers what the user already typed.
 */
export function useDictationInsert(
  setValue: React.Dispatch<React.SetStateAction<string>>,
) {
  const baseRef = useRef('');
  const sessionRef = useRef(-1);

  return useCallback(
    (text: string, _isFinal: boolean, session: number) => {
      setValue((prev) => {
        if (session !== sessionRef.current) {
          // New dictation session — remember whatever was already in the input.
          sessionRef.current = session;
          baseRef.current = prev;
        }
        const base = baseRef.current;
        return base.trim() ? `${base.trimEnd()} ${text}` : text;
      });
    },
    [setValue],
  );
}
