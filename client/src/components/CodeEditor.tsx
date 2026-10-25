import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import type { CodeLang } from '../lib/api';

// Each language's highlighting loads only when that language is chosen.
const modes: Record<CodeLang, () => Promise<Extension>> = {
  javascript: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  python: () => import('@codemirror/lang-python').then(m => m.python()),
  java: () => import('@codemirror/lang-java').then(m => m.java()),
  cpp: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql({ dialect: m.SQLite })),
};

// CodeMirror works on phones and keeps the coding page small. Tab indents; press Escape, then Tab, to move on.
export function CodeEditor({ value, language, onChange, onRun, label }: { value: string; language: CodeLang; onChange: (value: string) => void; onRun?: () => void; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const mode = useRef(new Compartment());
  const latest = useRef({ onChange, onRun });
  latest.current = { onChange, onRun };
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [
        basicSetup, oneDark, mode.current.of([]), EditorState.tabSize.of(4),
        keymap.of([{ key: 'Mod-Enter', run: () => { latest.current.onRun?.(); return true; } }, indentWithTab]),
        EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
        EditorView.contentAttributes.of({ 'aria-label': label, 'aria-describedby': 'editor-help' }),
      ] }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    let live = true;
    modes[language]().then(extension => { if (live) view.current?.dispatch({ effects: mode.current.reconfigure(extension) }); }).catch(() => {});
    return () => { live = false; };
  }, [language]);
  // Replace the text only when it changed from outside (a reset or a restored submission), not on every keystroke.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  return <><div className="code-editor" ref={host}/><p id="editor-help" className="editor-help">Tab indents. Press Escape, then Tab, to leave the editor. Ctrl+Enter (⌘+Enter) runs the examples.</p></>;
}
