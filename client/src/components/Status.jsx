import React from 'react';
import { humanStatus } from '../lib/api.js';
export default function Status({ value }) { const key = String(value || 'unknown').toLowerCase(); return <span className={`status status-${key.replace(/[^a-z0-9-]/g,'-')}`}>{humanStatus(value)}</span>; }
