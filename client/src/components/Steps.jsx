import React from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
export default function Steps({ title = 'How it works', steps = [] }) {
  return <section className="panel steps-panel"><div className="panel-title"><div><h2>{title}</h2><p className="muted">Follow these steps in order.</p></div></div><ol className="steps-list">{steps.map((step, index) => <li key={step.title}><span className="step-icon">{step.done ? <CheckCircle2 size={17}/> : <Circle size={17}/>}</span><div><strong>{index + 1}. {step.title}</strong><p>{step.description}</p></div></li>)}</ol></section>;
}
