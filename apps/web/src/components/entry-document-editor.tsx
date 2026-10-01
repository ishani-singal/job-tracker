'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '@/lib/api';
import { useSessionsPanel } from '@/lib/sessions-panel-context';
import type { StoryEntryType } from '@job-tracker/shared-types';

const AUTOSAVE_DEBOUNCE_MS = 2000;
const PREVIEW_CHAR_LIMIT = 140;

/** Strips HTML tags down to a single-line plain-text preview, for the
 * collapsed state — the full document only renders (as rich text) once
 * expanded, so a background section with many entries stays scannable. */
function htmlToPreviewText(html: string): string {
  const text = html
    .replace(/<\/(p|h[1-3]|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_CHAR_LIMIT ? `${text.slice(0, PREVIEW_CHAR_LIMIT)}…` : text;
}

/**
 * One entry's detailed document — a user-editable rich-text document
 * (Tiptap, stored as HTML) generated on demand from that entry's tagged
 * Stories/Resume files and connected GitHub repo. Replaces the old
 * NarrativePreview (which only showed a read-only, auto-extracted
 * narrative) — this is the sole content source resume/LinkedIn/
 * company-resume generation reads for this entry.
 *
 * Clicking "Generate" starts a chat-style session (ENTRY_DOCUMENT scope,
 * see sessions-panel.tsx) that revises the current document (if any) using
 * the entry's raw sources, preserving hand-edits except where new source
 * material supersedes them — never a blind from-scratch overwrite (see
 * agent/resu/stories/ for the actual merge logic). The agent may ask a
 * clarifying question in that chat before finishing; the result is only
 * saved here once the user explicitly clicks Accept in the sessions panel
 * (which invalidates this component's query, pulling in the new content).
 * Manual edits to an already-saved document still autosave (debounced) via
 * PUT /stories/document — that's a separate, lower-stakes path from the
 * full Generate/Accept session flow.
 */
export function EntryDocumentEditor({
  entryType,
  entryId,
  entryLabel,
  sourceCount,
}: {
  entryType: StoryEntryType;
  entryId: string;
  entryLabel: string;
  sourceCount: number;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['entry-document', entryType, entryId];

  const { data: doc, isLoading } = useQuery({
    queryKey,
    queryFn: () => api.getDocumentForEntry(entryType, entryId),
  });

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [expanded, setExpanded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveMutation = useMutation({
    mutationFn: (contentHtml: string) => api.saveDocumentForEntry(entryType, entryId, contentHtml),
    onMutate: () => setSaveStatus('saving'),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      setSaveStatus('saved');
    },
  });

  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: doc?.contentHtml ?? '',
      immediatelyRender: false,
      onUpdate: ({ editor }) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveMutation.mutate(editor.getHTML());
        }, AUTOSAVE_DEBOUNCE_MS);
      },
    },
    [doc?.contentHtml],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const { openPanel } = useSessionsPanel();
  const generateMutation = useMutation({
    mutationFn: () => api.startEntryDocumentSession(entryType, entryId, entryLabel),
    onSuccess: (session) => openPanel(session.id),
  });

  if (isLoading) {
    return <p className="text-xs opacity-50 italic border-t pt-1">Loading document…</p>;
  }

  if (sourceCount === 0 && !doc?.contentHtml) {
    return (
      <p className="text-xs opacity-50 italic border-t pt-1">
        No Stories/Resume file or GitHub repo tagged to this entry yet — tag one when
        uploading/connecting, then generate a detailed document for it.
      </p>
    );
  }

  return (
    <div className="text-xs border-t pt-1 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="opacity-70">
          {sourceCount} source{sourceCount === 1 ? '' : 's'} tagged
          {saveMutation.isPending || saveStatus === 'saving' ? ' · Saving…' : ''}
          {saveStatus === 'saved' && !saveMutation.isPending ? ' · Saved' : ''}
        </span>
        <button
          className="opacity-70 hover:opacity-100 underline disabled:opacity-40"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending || sourceCount === 0}
          title={sourceCount === 0 ? 'Tag a source to this entry first' : undefined}
        >
          {generateMutation.isPending ? 'Starting…' : doc?.contentHtml ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {doc?.contentHtml ? (
        expanded ? (
          <div className="flex flex-col gap-1">
            <div className="prose prose-sm dark:prose-invert max-w-none border rounded px-2 py-1 [&_.ProseMirror]:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
              <EditorContent editor={editor} />
            </div>
            <button
              className="self-start opacity-70 hover:opacity-100 underline"
              onClick={() => setExpanded(false)}
            >
              Collapse
            </button>
          </div>
        ) : (
          <button
            className="text-left opacity-70 hover:opacity-100 italic"
            onClick={() => setExpanded(true)}
          >
            {htmlToPreviewText(doc.contentHtml) || '(empty document)'}
          </button>
        )
      ) : (
        <p className="opacity-50 italic">No document generated yet.</p>
      )}
    </div>
  );
}
