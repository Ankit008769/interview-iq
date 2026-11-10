import { Code2, FileText } from 'lucide-react';
import type { DocumentKind, QuestionGrounding } from '../lib/api';

export const kindLabel = (kind: DocumentKind) => kind === 'resume' ? 'resume' : 'job description';

// The source line is shown only when the server found it verbatim in the document.
export function QuestionSource({ grounding }: { grounding?: QuestionGrounding }) {
  if (!grounding) return null;
  // Project defense: the question is about this code from the uploaded project (secrets already removed).
  if (grounding.code) {
    const code = grounding.code;
    return <div className="question-source code-source"><p><Code2 size={14} aria-hidden="true"/>
      <span>About your code: <code>{code.path}</code> · <code>{code.symbol}</code> (lines {code.startLine}–{code.endLine})</span></p>
      <details><summary>Show the code</summary><pre className="code-block small">{code.excerpt}</pre></details></div>;
  }
  return <p className="question-source"><FileText size={14} aria-hidden="true"/>
    {grounding.source
      ? <span>Based on your {kindLabel(grounding.source.kind)}: “{grounding.source.quote}”</span>
      : <span>Tailored to your documents. No exact source line was found for this question.</span>}
  </p>;
}
