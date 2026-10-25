import { FileText } from 'lucide-react';
import type { DocumentKind, QuestionGrounding } from '../lib/api';

export const kindLabel = (kind: DocumentKind) => kind === 'resume' ? 'resume' : 'job description';

// The source line is shown only when the server found it verbatim in the document.
export function QuestionSource({ grounding }: { grounding?: QuestionGrounding }) {
  if (!grounding) return null;
  return <p className="question-source"><FileText size={14} aria-hidden="true"/>
    {grounding.source
      ? <span>Based on your {kindLabel(grounding.source.kind)}: “{grounding.source.quote}”</span>
      : <span>Tailored to your documents. No exact source line was found for this question.</span>}
  </p>;
}
