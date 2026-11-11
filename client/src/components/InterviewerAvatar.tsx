import { useEffect, useRef, useState } from 'react';

// Optional 2D interviewer avatar (roadmap D4): a simple drawn face that blinks and moves its mouth while a
// question is read aloud (speech events from ReadAloud). It has no expressions and never reacts to the
// candidate. With reduced motion it stays still.
export function InterviewerAvatar({ size = 56 }: { size?: number }) {
  const [speaking, setSpeaking] = useState(false);
  const [open, setOpen] = useState(0);
  const [blink, setBlink] = useState(false);
  const reduced = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    let close: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      const type = (e as CustomEvent<string>).detail;
      if (type === 'end') { setSpeaking(false); setOpen(0); return; }
      setSpeaking(true);
      if (reduced.current) return;
      // Each word boundary opens the mouth briefly; some voices send none, so speaking alone keeps it moving.
      setOpen(0.6 + Math.random() * 0.4); clearTimeout(close); close = setTimeout(() => setOpen(0.15), 140);
    };
    window.addEventListener('iq-speech', on);
    return () => { window.removeEventListener('iq-speech', on); clearTimeout(close); };
  }, []);
  useEffect(() => {
    if (!speaking || reduced.current) return;
    const t = setInterval(() => setOpen(o => (o > 0.3 ? 0.1 : 0.5 + Math.random() * 0.4)), 180);
    return () => clearInterval(t);
  }, [speaking]);
  useEffect(() => {
    if (reduced.current) return;
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => { t = setTimeout(() => { setBlink(true); setTimeout(() => setBlink(false), 140); schedule(); }, 3000 + Math.random() * 3000); };
    schedule();
    return () => clearTimeout(t);
  }, []);
  const mouth = 1.5 + open * 6;
  return <svg className={`interviewer-avatar ${speaking ? 'speaking' : ''}`} width={size} height={size} viewBox="0 0 64 64" role="img"
    aria-label={speaking ? 'Interviewer avatar, speaking' : 'Interviewer avatar'} data-speaking={speaking ? 'true' : 'false'}>
    <circle cx="32" cy="32" r="31" className="avatar-bg"/>
    <path d="M14 30c0-12 8-19 18-19s18 7 18 19c-3-6-9-9-18-9s-15 3-18 9z" className="avatar-hair"/>
    <ellipse cx="32" cy="35" rx="15" ry="17" className="avatar-face"/>
    <ellipse cx="25.5" cy="32" rx="2.2" ry={blink ? 0.3 : 2.4} className="avatar-eye"/>
    <ellipse cx="38.5" cy="32" rx="2.2" ry={blink ? 0.3 : 2.4} className="avatar-eye"/>
    <path d="M22 27.5q3.5-2 7 0M35 27.5q3.5-2 7 0" className="avatar-brow"/>
    <ellipse cx="32" cy="43.5" rx="5" ry={mouth / 2} className="avatar-mouth"/>
  </svg>;
}
