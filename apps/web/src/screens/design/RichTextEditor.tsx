import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Node as TipNode, mergeAttributes } from '@tiptap/core';
import type { RichDoc } from '@iss/model';

/** Inline atom node for allowlisted data tokens: serialises as {type:'token', attrs:{path}}. */
const TokenNode = TipNode.create({
  name: 'token',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { path: { default: '' } }; },
  parseHTML() { return [{ tag: 'span[data-token]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-token': node.attrs.path, class: 'rte-token', contenteditable: 'false' }), `{{${node.attrs.path}}}`];
  },
  renderText({ node }) { return `{{${node.attrs.path}}}`; },
});

/** The currently focused rich-text editor, so the inspector's token picker can insert into it. */
export const activeEditor: { current: Editor | null } = { current: null };

export function insertToken(path: string): boolean {
  const ed = activeEditor.current;
  if (!ed || ed.isDestroyed) return false;
  ed.chain().focus().insertContent({ type: 'token', attrs: { path } }).insertContent(' ').run();
  return true;
}

export function RichTextEditor({ value, onCommit, onCancel }: { value: RichDoc | undefined; onCommit: (doc: RichDoc) => void; onCancel: () => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, codeBlock: false, code: false, blockquote: false, horizontalRule: false, strike: false }),
      Link.configure({ openOnClick: false, autolink: false, protocols: ['https'], validate: (href) => /^https:\/\//.test(href) }),
      TokenNode,
    ],
    content: (value as any) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    autofocus: 'end',
    editorProps: { attributes: { class: 'rte-content', 'aria-label': 'Rich text editor', 'data-testid': 'rich-text-editor' } },
  });
  useEffect(() => {
    if (editor) activeEditor.current = editor;
    return () => { if (activeEditor.current === editor) activeEditor.current = null; };
  }, [editor]);
  if (!editor) return null;
  const commit = () => onCommit(editor.getJSON() as RichDoc);
  return (
    <div className="rte" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); commit(); } e.stopPropagation(); }}>
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" aria-pressed={editor.isActive('bold')} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }} title="Bold"><b>B</b></button>
        <button type="button" aria-pressed={editor.isActive('italic')} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }} title="Italic"><i>I</i></button>
        <button type="button" aria-pressed={editor.isActive('heading', { level: 2 })} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }} title="Heading">H</button>
        <button type="button" aria-pressed={editor.isActive('bulletList')} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }} title="Bulleted list">•≡</button>
        <button type="button" onMouseDown={(e) => {
          e.preventDefault();
          const href = window.prompt('Safe https:// link');
          if (href && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(href)) editor.chain().focus().setLink({ href }).run();
        }} title="Link">🔗</button>
        <span className="rte-hint">Insert data tokens from the Inspector · Esc to finish</span>
        <button type="button" className="rte-done" onMouseDown={(e) => { e.preventDefault(); commit(); }} data-testid="rich-text-done">Done</button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); onCancel(); }}>Cancel</button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
