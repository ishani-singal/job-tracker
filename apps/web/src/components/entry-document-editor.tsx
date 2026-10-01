'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '@/lib/api';
import type { StoryEntryType } from '@job-tracker/shared-types';

const AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * One entry's detailed document — a user-editable rich-text document
 * (Tiptap, stored as HTML) generated on demand from that entry's tagged
 * Stories/Resume files and connected GitHub repo. Replaces the old
 * NarrativePreview (which only showed a read-only, auto-extracted
 * narrative) — this is the sole content source resume/LinkedIn/
 * company-resume generation reads for this entry.
 *
 * Clicking "Generate" revises the current document (if any) using the
 * entry's raw sources, preserving hand-edits except where new source
 * material supersedes them — never a blind from-scratch overwrite (see
 * agent/resu/stories/ for the actual merge logic). Manual edits autosave
 * (debounced) via PUT /stories/document.
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

  const generateMutation = useMutation({
    mutationFn: () => api.generateDocumentForEntry(entryType, entryId, entryLabel),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      editor?.commands.setContent(result.contentHtml);
      setSaveStatus('saved');
    },
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
          {generateMutation.isPending ? 'Generating…' : doc?.contentHtml ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {doc?.contentHtml || editor?.getHTML() ? (
        <div className="prose prose-sm dark:prose-invert max-w-none border rounded px-2 py-1 [&_.ProseMirror]:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
          <EditorContent editor={editor} />
        </div>
      ) : (
        <p className="opacity-50 italic">No document generated yet.</p>
      )}
    </div>
  );
}
