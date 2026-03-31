import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Shield, MessageSquare, Zap, Plus, Trash2, Send,
  Bot, Globe, Activity, Eye, EyeOff, Check, X, Loader,
  Terminal, Hash, Mail, Radio,
  Lock, AlertTriangle, Clock, Users,
  ChevronLeft, ChevronRight, Columns3, LayoutGrid,
  Sparkles, ArrowRight, Command,
  Database, Cpu, Wifi, WifiOff
} from 'lucide-react';
import type { CSSProperties, ReactNode, FormEvent } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Instance {
  id: string;
  name: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  container_id: string | null;
  created_at: string;
  config: { name: string; model: string; google_gemini_api_key: string | null };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  verdict?: 'pass' | 'block' | 'redact';
  violations?: string[];
}

interface AuditEvent {
  id: string;
  instance_id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  verdict: 'pass' | 'block' | 'redact';
  violation_types: string[];
  original_preview: string;
  reasoning?: string;
  model_used?: string;
}

interface ChannelInfo {
  channel: string;
  account?: string;
  enabled?: boolean;
  status: string;
  connected_at?: string;
}

interface WorkflowTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  template_id: string | null;
  channels: string[];
  schedule: string | null;
  created_at: number;
}

interface Template {
  id: string;
  title: string;
  description: string;
  category: string;
  channels: string[];
  schedule: string;
  icon: string;
}

type Screen = 'setup' | 'instances' | 'workflows' | 'dashboard' | 'deadman';
type InstanceTab = 'chat' | 'channels';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const API = '';

// Authenticated fetch wrapper — attaches Bearer token to all API requests
function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = sessionStorage.getItem('assistantx_token') || '';
  const headers = new Headers(opts.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...opts, headers });
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function loadChat(id: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`assistantx-chat-${id}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveChat(id: string, msgs: ChatMessage[]): void {
  localStorage.setItem(`assistantx-chat-${id}`, JSON.stringify(msgs));
}

function clearChat(id: string): void {
  localStorage.removeItem(`assistantx-chat-${id}`);
}

function statusColor(s: string): string {
  switch (s) {
    case 'running': return 'var(--pass)';
    case 'creating': return 'var(--warn)';
    case 'error': return 'var(--block)';
    default: return 'var(--text-muted)';
  }
}

function verdictColor(v: string): string {
  switch (v) {
    case 'pass': return 'var(--pass)';
    case 'block': return 'var(--block)';
    case 'redact': return 'var(--warn)';
    default: return 'var(--text-muted)';
  }
}

function verdictBg(v: string): string {
  switch (v) {
    case 'pass': return 'var(--pass-light)';
    case 'block': return 'var(--block-light)';
    case 'redact': return 'var(--warn-light)';
    default: return 'var(--surface2)';
  }
}

function timeSince(ts: string): string {
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const CHANNEL_ICONS: Record<string, ReactNode> = {
  telegram: <Send size={16} />,
  discord: <Hash size={16} />,
  slack: <MessageSquare size={16} />,
  whatsapp: <Globe size={16} />,
  signal: <Lock size={16} />,
  imessage: <Mail size={16} />,
};

const CHANNEL_META: Record<string, { label: string; description: string; fields: string[] }> = {
  telegram: { label: 'Telegram', description: 'Connect a Telegram bot via BotFather token', fields: ['token'] },
  discord: { label: 'Discord', description: 'Connect a Discord bot with bot token', fields: ['bot_token'] },
  slack: { label: 'Slack', description: 'Connect a Slack workspace app', fields: ['bot_token', 'app_token'] },
  whatsapp: { label: 'WhatsApp', description: 'Connect via WhatsApp Business API', fields: ['token'] },
  signal: { label: 'Signal', description: 'Connect via Signal messenger', fields: ['token'] },
};

const WORKFLOW_ICONS: Record<string, ReactNode> = {
  mail: <Mail size={16} />,
  calendar: <Clock size={16} />,
  users: <Users size={16} />,
  search: <Globe size={16} />,
  github: <Terminal size={16} />,
  clipboard: <Activity size={16} />,
  globe: <Globe size={16} />,
  radio: <Radio size={16} />,
  receipt: <Activity size={16} />,
  rocket: <Zap size={16} />,
};

const CHANNEL_BRAND_COLORS: Record<string, string> = {
  telegram: '#2AABEE',
  discord: '#5865F2',
  slack: '#7C3AED',
  whatsapp: '#25D366',
  signal: '#6B7280',
};

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const S = {
  glass: {
    background: 'rgba(15, 20, 35, 0.65)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  } as CSSProperties,
  card: {
    background: 'var(--surface)',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-sm)',
    transition: 'all 0.2s ease',
  } as CSSProperties,
  cardHoverable: {
    background: 'var(--surface)',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-sm)',
    transition: 'all 0.2s ease',
    cursor: 'pointer',
  } as CSSProperties,
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text)',
    fontSize: '13px',
    lineHeight: '1.5',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  } as CSSProperties,
  btnPrimary: {
    padding: '10px 20px',
    borderRadius: 'var(--radius-sm)',
    background: 'linear-gradient(135deg, #0069ff, #2570ff)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '13px',
    border: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.2s ease',
    boxShadow: '0 2px 8px rgba(37, 112, 255, 0.25)',
  } as CSSProperties,
  btnGhost: {
    padding: '8px 14px',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontWeight: 500,
    fontSize: '13px',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.2s ease',
  } as CSSProperties,
  label: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '6px',
    display: 'block',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
  } as CSSProperties,
  gradientText: {
    background: 'linear-gradient(135deg, #2570ff, #2570ff)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  } as CSSProperties,
  transition: {
    transition: 'all 0.2s ease',
  } as CSSProperties,
};

// ---------------------------------------------------------------------------
// NavBar
// ---------------------------------------------------------------------------

function NavBar({
  screen,
  setScreen,
  instanceCount,
  hasRunning,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  instanceCount: number;
  hasRunning: boolean;
}) {
  const tabs: { key: Screen; label: string; icon: ReactNode }[] = [
    { key: 'setup', label: 'Setup', icon: <Sparkles size={14} /> },
    { key: 'instances', label: 'Instances', icon: <Cpu size={14} /> },
    { key: 'workflows', label: 'Workflows', icon: <Zap size={14} /> },
    { key: 'dashboard', label: 'Dashboard', icon: <Shield size={14} /> },
    { key: 'deadman', label: 'Dead-Man Switch', icon: <Lock size={14} /> },
  ];

  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 100,
      height: '60px',
      background: 'rgba(10, 14, 26, 0.75)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 28px',
      boxShadow: '0 4px 24px rgba(0, 8, 40, 0.4)',
    }}>
      {/* Left: Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          width: 34, height: 34, borderRadius: '10px',
          background: 'linear-gradient(135deg, #0069ff, #2570ff, #0069ff)',
          backgroundSize: '200% 200%',
          animation: 'gradientBorder 4s ease infinite',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: '16px',
          boxShadow: '0 0 16px rgba(37, 112, 255, 0.3)',
        }}>
          <span style={{ fontWeight: 800, fontSize: '17px', color: '#fff', fontFamily: 'Inter, sans-serif' }}>O</span>
        </div>
        <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text)', letterSpacing: '-0.3px' }}>
          ombre
        </span>
        <div style={{
          fontSize: '10px', fontWeight: 600, color: '#2570ff',
          background: 'rgba(37, 112, 255, 0.12)',
          padding: '3px 10px', borderRadius: '10px',
          letterSpacing: '0.4px', textTransform: 'uppercase',
          border: '1px solid rgba(37, 112, 255, 0.2)',
          animation: 'livePulse 3s ease-in-out infinite',
          display: 'flex', alignItems: 'center', gap: '5px',
        }}>
          <Database size={10} />
          DO Gradient
        </div>
      </div>

      {/* Center: Tab pills */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        background: 'rgba(22, 28, 48, 0.6)',
        backdropFilter: 'blur(12px)',
        borderRadius: '12px', padding: '4px',
        border: '1px solid var(--border-light)',
      }}>
        {tabs.map(t => {
          const isActive = screen === t.key;
          return (
            <button key={t.key} onClick={() => setScreen(t.key)} style={{
              padding: '7px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
              background: isActive ? 'linear-gradient(135deg, #0069ff, #2570ff)' : 'transparent',
              color: isActive ? '#fff' : '#c8d4e8',
              border: 'none', cursor: 'pointer',
              transition: 'all 0.2s ease',
              display: 'flex', alignItems: 'center', gap: '6px',
              boxShadow: isActive ? '0 0 12px rgba(37, 112, 255, 0.4)' : 'none',
              position: 'relative',
            }}>
              {t.icon}
              {t.label}
              {t.key === 'instances' && instanceCount > 0 && (
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  background: isActive ? 'rgba(255,255,255,0.25)' : 'var(--accent-light)',
                  color: isActive ? '#fff' : 'var(--accent)',
                  padding: '1px 6px', borderRadius: '6px',
                  minWidth: '18px', textAlign: 'center',
                }}>{instanceCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right: Connection status + avatar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '12px', color: hasRunning ? 'var(--pass)' : 'var(--text-muted)',
          fontWeight: 500,
        }}>
          {hasRunning ? (
            <>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--pass)',
                animation: 'livePulse 2s infinite',
              }} />
              <Wifi size={14} />
            </>
          ) : (
            <>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)',
              }} />
              <WifiOff size={14} />
            </>
          )}
        </div>
        <div style={{
          width: 34, height: 34, borderRadius: '50%',
          background: 'linear-gradient(135deg, #0069ff, #2570ff)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 600, fontSize: '14px',
          boxShadow: '0 0 12px rgba(37, 112, 255, 0.2)',
          border: '2px solid rgba(255,255,255,0.1)',
        }}>Y</div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: Setup
// ---------------------------------------------------------------------------

function SetupScreen({ onCreated }: { onCreated: (inst: Instance) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  const scrollToBottom = useCallback(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Auto-send welcome
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const welcome: ChatMessage = { id: uid(), role: 'user', content: 'hi, help me get started with Ombre', ts: Date.now() };
    setMessages([welcome]);
    setSending(true);
    authFetch(`${API}/api/onboard/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: welcome.content }] }),
    }).then(r => r.json()).then(d => {
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: d.content, ts: Date.now() }]);
    }).catch(() => {
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: 'Welcome to AssistantX! I can help you set up your first AI instance. Fill out the form on the right to get started.', ts: Date.now() }]);
    }).finally(() => setSending(false));
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: input.trim(), ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const r = await authFetch(`${API}/api/onboard/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const d = await r.json();
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: d.content, ts: Date.now() }]);
    } catch {
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.', ts: Date.now() }]);
    } finally { setSending(false); }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const r = await authFetch(`${API}/api/instances`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), google_gemini_api_key: apiKey.trim() || undefined }),
      });
      const inst = await r.json();
      onCreated(inst);
    } catch { /* noop */ } finally { setCreating(false); }
  };

  const features = [
    { icon: <Shield size={20} />, title: 'Guardrail Protection', desc: 'PII filtering, injection blocking, and content moderation', gradient: 'linear-gradient(135deg, #0069ff, #3b82f6)' },
    { icon: <Zap size={20} />, title: 'Workflow Automation', desc: 'Automate tasks across channels with templates', gradient: 'linear-gradient(135deg, #2570ff, #5a9aff)' },
    { icon: <Activity size={20} />, title: 'Real-time Audit', desc: 'Live monitoring and audit trail of all interactions', gradient: 'linear-gradient(135deg, #22c55e, #4ade80)' },
  ];

  const [hoveredFeature, setHoveredFeature] = useState<number | null>(null);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
      {/* Left: Onboarding Chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: '12px',
          background: 'rgba(15, 20, 35, 0.5)',
          backdropFilter: 'blur(12px)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '10px',
            background: 'linear-gradient(135deg, #0069ff, #2570ff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 12px rgba(37, 112, 255, 0.3)',
          }}>
            <Bot size={16} style={{ color: '#fff' }} />
          </div>
          <div>
            <span style={{ fontWeight: 600, fontSize: '14px', display: 'block' }}>Onboarding Assistant</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Powered by DO Gradient</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', background: 'var(--pass)',
              animation: 'livePulse 2s infinite',
            }} />
            <span style={{ fontSize: '11px', color: 'var(--pass)', fontWeight: 500 }}>Online</span>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {messages.map(m => (
            <div key={m.id} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
              display: 'flex',
              flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
              gap: '10px',
              alignItems: 'flex-start',
              animation: 'fadeIn 0.35s ease-out both',
            }}>
              {/* Avatar */}
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: m.role === 'user'
                  ? 'linear-gradient(135deg, #2570ff, #5a9aff)'
                  : 'linear-gradient(135deg, #0069ff, #3b82f6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: m.role === 'user'
                  ? '0 0 10px rgba(37, 112, 255, 0.3)'
                  : '0 0 10px rgba(37, 112, 255, 0.3)',
              }}>
                {m.role === 'user' ? <Sparkles size={14} color="#fff" /> : <Bot size={14} color="#fff" />}
              </div>
              {/* Bubble */}
              <div style={{
                padding: '12px 16px', fontSize: '13px', lineHeight: '1.7',
                borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: m.role === 'user'
                  ? 'linear-gradient(135deg, #0069ff, #2570ff)'
                  : 'var(--surface2)',
                color: m.role === 'user' ? '#fff' : 'var(--text)',
                border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                boxShadow: m.role === 'user'
                  ? '0 4px 16px rgba(37, 112, 255, 0.2)'
                  : 'var(--shadow-sm)',
              }}>
                {m.role === 'assistant' ? (
                  <div className="markdown"><ReactMarkdown>{m.content}</ReactMarkdown></div>
                ) : m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px',
              animation: 'fadeIn 0.35s ease-out both',
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: 'linear-gradient(135deg, #0069ff, #3b82f6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 10px rgba(37, 112, 255, 0.3)',
              }}>
                <Bot size={14} color="#fff" />
              </div>
              <div style={{
                padding: '14px 18px', borderRadius: '16px 16px 16px 4px',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                display: 'flex', gap: '5px', alignItems: 'center',
              }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{
                    width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
                    animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }} />
                ))}
              </div>
            </div>
          )}
          <div ref={chatEnd} />
        </div>

        <div style={{
          padding: '16px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: '10px',
          background: 'rgba(15, 20, 35, 0.5)',
          backdropFilter: 'blur(12px)',
        }}>
          <input
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
            placeholder="Ask about AssistantX..."
            style={{ ...S.input, flex: 1 }}
          />
          <button onClick={sendMessage} disabled={sending || !input.trim()} style={{
            ...S.btnPrimary,
            opacity: sending || !input.trim() ? 0.4 : 1,
            padding: '10px 16px',
          }}><Send size={16} /></button>
        </div>
      </div>

      {/* Right: Get Started Form */}
      <div style={{
        width: '440px', overflow: 'auto', padding: '32px 28px',
        display: 'flex', flexDirection: 'column', gap: '28px',
        background: 'rgba(15, 20, 35, 0.4)',
      }}>
        <div>
          <h2 style={{
            fontSize: '24px', fontWeight: 700, marginBottom: '8px',
            ...S.gradientText,
          }}>Get Started</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.6' }}>
            Create your first AssistantX instance with DO Gradient guardrails.
          </p>
        </div>

        <div style={{
          ...S.glass,
          padding: '24px',
        }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div>
              <label style={S.label}>Instance Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="my-agent" style={S.input} />
            </div>
            <div>
              <label style={S.label}>Google Gemini API Key</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder="Optional — uses DO Gradient if empty"
                  style={{ ...S.input, paddingRight: '42px' }}
                />
                <button type="button" onClick={() => setShowKey(!showKey)} style={{
                  position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: 'var(--text-muted)', padding: '4px',
                  cursor: 'pointer', transition: 'color 0.2s',
                }}>
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={!name.trim() || creating} style={{
              ...S.btnPrimary, width: '100%', justifyContent: 'center',
              opacity: !name.trim() || creating ? 0.5 : 1,
              padding: '12px 20px', fontSize: '14px', fontWeight: 600,
              position: 'relative', overflow: 'hidden',
            }}>
              {creating ? (
                <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Creating...</>
              ) : (
                <>
                  <Zap size={16} /> Create & Launch
                  <ArrowRight size={16} style={{ marginLeft: '4px' }} />
                </>
              )}
              {/* Shimmer overlay */}
              {!creating && name.trim() && (
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)',
                  backgroundSize: '400px 100%',
                  animation: 'shimmer 2.5s infinite linear',
                  pointerEvents: 'none',
                }} />
              )}
            </button>
          </form>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Included Features
          </span>
          {features.map((f, i) => (
            <div
              key={i}
              onMouseEnter={() => setHoveredFeature(i)}
              onMouseLeave={() => setHoveredFeature(null)}
              style={{
                ...S.card, padding: '18px', display: 'flex', gap: '14px', alignItems: 'flex-start',
                border: hoveredFeature === i ? '1px solid rgba(37, 112, 255, 0.3)' : '1px solid var(--border)',
                boxShadow: hoveredFeature === i ? '0 0 20px rgba(37, 112, 255, 0.1)' : 'var(--shadow-sm)',
                filter: hoveredFeature === i ? 'brightness(1.1)' : 'brightness(1)',
                cursor: 'default',
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: '12px',
                background: f.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', flexShrink: 0,
                boxShadow: `0 4px 12px ${f.gradient.includes('#0069ff') ? 'rgba(37,112,255,0.3)' : f.gradient.includes('#2570ff') ? 'rgba(37,112,255,0.3)' : 'rgba(34,197,94,0.3)'}`,
              }}>{f.icon}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '3px', color: 'var(--text)' }}>{f.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 2: Instances
// ---------------------------------------------------------------------------

function InstancesScreen({
  instances, selectedId, onSelect, onRefresh,
}: {
  instances: Instance[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<InstanceTab>('chat');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const selected = instances.find(i => i.id === selectedId) || null;

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const r = await authFetch(`${API}/api/instances`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), google_gemini_api_key: newKey.trim() || undefined }),
      });
      if (r.ok) {
        const inst = await r.json();
        onSelect(inst.id);
        setNewName('');
        setNewKey('');
        setShowCreate(false);
        onRefresh();
      }
    } catch { /* noop */ } finally { setCreating(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await authFetch(`${API}/api/instances/${id}`, { method: 'DELETE' });
      if (selectedId === id) onSelect(null);
      clearChat(id);
      onRefresh();
    } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{
        width: '270px', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        background: 'rgba(15, 20, 35, 0.5)',
        backdropFilter: 'blur(16px)',
      }}>
        <div style={{
          padding: '16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cpu size={16} style={{ color: 'var(--accent)' }} />
            <span style={{ fontWeight: 600, fontSize: '14px' }}>Instances</span>
            <span style={{
              fontSize: '10px', fontWeight: 700,
              background: 'var(--accent-light)', color: 'var(--accent)',
              padding: '2px 7px', borderRadius: '6px',
            }}>{instances.length}</span>
          </div>
          <button onClick={() => setShowCreate(!showCreate)} style={{
            ...S.btnPrimary, padding: '6px 10px', fontSize: '12px',
            borderRadius: '8px',
          }}><Plus size={14} /></button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} style={{
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: '8px',
            background: 'rgba(22, 28, 48, 0.5)',
            animation: 'fadeIn 0.2s ease-out',
          }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Instance name" style={{ ...S.input, fontSize: '12px', padding: '8px 10px' }} />
            <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="API key (optional)" type="password" style={{ ...S.input, fontSize: '12px', padding: '8px 10px' }} />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button type="submit" disabled={!newName.trim() || creating} style={{
                ...S.btnPrimary, flex: 1, padding: '7px', fontSize: '12px', justifyContent: 'center',
                opacity: !newName.trim() || creating ? 0.5 : 1,
              }}>{creating ? 'Creating...' : 'Create'}</button>
              <button type="button" onClick={() => setShowCreate(false)} style={{ ...S.btnGhost, padding: '7px 12px', fontSize: '12px' }}><X size={14} /></button>
            </div>
          </form>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
          {instances.length === 0 && (
            <div style={{
              padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px',
              animation: 'fadeIn 0.35s ease-out',
            }}>
              <Cpu size={28} style={{ opacity: 0.2, marginBottom: '10px' }} />
              <div>No instances yet</div>
              <div style={{ fontSize: '11px', marginTop: '4px' }}>Click + to create one</div>
            </div>
          )}
          {instances.map(inst => {
            const isSelected = selectedId === inst.id;
            const isHovered = hoveredId === inst.id;
            return (
              <div
                key={inst.id}
                onClick={() => onSelect(inst.id)}
                onMouseEnter={() => setHoveredId(inst.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  padding: '12px 14px', borderRadius: '10px', cursor: 'pointer',
                  background: isSelected
                    ? 'linear-gradient(135deg, rgba(37, 112, 255, 0.15), rgba(37, 112, 255, 0.1))'
                    : isHovered ? 'var(--surface2)' : 'transparent',
                  border: isSelected ? '1px solid rgba(37, 112, 255, 0.3)' : '1px solid transparent',
                  display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px',
                  transition: 'all 0.2s ease',
                  boxShadow: isSelected ? '0 0 12px rgba(37, 112, 255, 0.1)' : 'none',
                }}
              >
                {/* Status pulse dot */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: statusColor(inst.status),
                    animation: inst.status === 'running' ? 'livePulse 2s infinite' : 'none',
                  }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '13px', fontWeight: isSelected ? 600 : 500,
                    color: isSelected ? '#fff' : 'var(--text)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{inst.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                    {inst.status} · {timeSince(inst.created_at)}
                  </div>
                </div>
                {isHovered && (
                  <button onClick={e => { e.stopPropagation(); handleDelete(inst.id); }} style={{
                    background: 'var(--block-light)', border: '1px solid rgba(239, 68, 68, 0.2)',
                    borderRadius: '6px', color: 'var(--block)', padding: '5px', cursor: 'pointer',
                    flexShrink: 0, display: 'flex', transition: 'all 0.15s ease',
                  }}><Trash2 size={13} /></button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main area */}
      {!selected ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)',
          background: 'radial-gradient(circle at 50% 50%, rgba(37, 112, 255, 0.03), transparent 60%)',
        }}>
          <div style={{ textAlign: 'center', animation: 'fadeIn 0.5s ease-out' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '20px', margin: '0 auto 16px',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Command size={28} style={{ opacity: 0.3, color: 'var(--accent)' }} />
            </div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>Select an instance</div>
            <div style={{ fontSize: '13px' }}>or create a new one to get started</div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Tab bar */}
          <div style={{
            padding: '0 24px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: '8px', height: '52px',
            background: 'rgba(15, 20, 35, 0.4)',
            backdropFilter: 'blur(12px)',
          }}>
            <span style={{ fontWeight: 600, fontSize: '15px', marginRight: '12px', color: 'var(--text)' }}>{selected.name}</span>
            <div style={{
              display: 'flex', gap: '2px',
              background: 'var(--surface2)', borderRadius: '8px', padding: '3px',
            }}>
              {(['chat', 'channels'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '5px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 500,
                  color: tab === t ? '#fff' : 'var(--text-secondary)',
                  background: tab === t ? 'linear-gradient(135deg, #0069ff, #2570ff)' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  transition: 'all 0.2s ease', textTransform: 'capitalize',
                  boxShadow: tab === t ? '0 0 8px rgba(37, 112, 255, 0.3)' : 'none',
                }}>
                  {t === 'chat' ? <MessageSquare size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> : <Globe size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />}
                  {t}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{
              fontSize: '11px', padding: '4px 12px', borderRadius: '10px', fontWeight: 600,
              background: verdictBg(selected.status === 'running' ? 'pass' : selected.status === 'error' ? 'block' : 'redact'),
              color: statusColor(selected.status),
              textTransform: 'capitalize',
              display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: statusColor(selected.status),
                animation: selected.status === 'running' ? 'livePulse 2s infinite' : 'none',
              }} />
              {selected.status}
            </span>
          </div>

          {tab === 'chat' ? <ChatPanel instanceId={selected.id} /> : <ChannelsPanel instanceId={selected.id} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

function ChatPanel({ instanceId }: { instanceId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadChat(instanceId));
  }, [instanceId]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: input.trim(), ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    saveChat(instanceId, next);
    setInput('');
    setSending(true);
    try {
      const r = await authFetch(`${API}/api/proxy/${instanceId}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg.content }),
      });
      const d = await r.json();
      const asstMsg: ChatMessage = {
        id: uid(), role: 'assistant', content: d.content, ts: Date.now(),
        verdict: d.verdict, violations: d.violations,
      };
      const updated = [...next, asstMsg];
      setMessages(updated);
      saveChat(instanceId, updated);
    } catch {
      const errMsg: ChatMessage = { id: uid(), role: 'assistant', content: 'Failed to send message.', ts: Date.now() };
      const updated = [...next, errMsg];
      setMessages(updated);
      saveChat(instanceId, updated);
    } finally { setSending(false); }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {messages.length === 0 && (
          <div style={{
            margin: 'auto', textAlign: 'center', color: 'var(--text-muted)',
            animation: 'fadeIn 0.5s ease-out',
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: '16px', margin: '0 auto 12px',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <MessageSquare size={24} style={{ opacity: 0.3, color: 'var(--accent)' }} />
            </div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>Start a conversation</div>
            <div style={{ fontSize: '12px' }}>Messages are protected by DO Gradient guardrails</div>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '75%',
            display: 'flex',
            flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
            gap: '10px',
            alignItems: 'flex-start',
            animation: 'fadeIn 0.3s ease-out',
          }}>
            {/* Avatar */}
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: m.role === 'user'
                ? 'linear-gradient(135deg, #2570ff, #5a9aff)'
                : 'linear-gradient(135deg, #0069ff, #3b82f6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: m.role === 'user'
                ? '0 0 8px rgba(37, 112, 255, 0.25)'
                : '0 0 8px rgba(37, 112, 255, 0.25)',
            }}>
              {m.role === 'user' ? <Sparkles size={13} color="#fff" /> : <Bot size={13} color="#fff" />}
            </div>
            {/* Bubble + verdict */}
            <div>
              <div style={{
                padding: '12px 16px', fontSize: '13px', lineHeight: '1.7',
                borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: m.role === 'user'
                  ? 'linear-gradient(135deg, #0069ff, #2570ff)'
                  : 'var(--surface2)',
                color: m.role === 'user' ? '#fff' : 'var(--text)',
                border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                boxShadow: m.role === 'user'
                  ? '0 4px 16px rgba(37, 112, 255, 0.15)'
                  : 'var(--shadow-sm)',
                position: 'relative',
              }}>
                {m.role === 'assistant' ? (
                  <div className="markdown"><ReactMarkdown>{m.content}</ReactMarkdown></div>
                ) : m.content}

                {/* Guard shield for blocked/redacted */}
                {m.verdict && m.verdict !== 'pass' && m.role === 'assistant' && (
                  <div style={{
                    position: 'absolute', top: '8px', right: '8px',
                    color: verdictColor(m.verdict), opacity: 0.6,
                  }}>
                    <Shield size={14} />
                  </div>
                )}
              </div>
              {/* Verdict footer on assistant messages */}
              {m.verdict && (
                <div style={{
                  display: 'flex', gap: '5px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center',
                  paddingLeft: m.role === 'assistant' ? '4px' : '0',
                }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px',
                    background: verdictBg(m.verdict), color: verdictColor(m.verdict), textTransform: 'uppercase',
                    letterSpacing: '0.3px',
                    display: 'flex', alignItems: 'center', gap: '3px',
                  }}>
                    {m.verdict === 'pass' ? <Check size={10} /> : m.verdict === 'block' ? <X size={10} /> : <EyeOff size={10} />}
                    {m.verdict}
                  </span>
                  {m.violations?.map((v, i) => (
                    <span key={i} style={{
                      fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                      background: 'var(--surface2)', color: 'var(--text-muted)',
                      border: '1px solid var(--border-light)',
                    }}>{v}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            animation: 'fadeIn 0.3s ease-out',
          }}>
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #0069ff, #3b82f6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 8px rgba(37, 112, 255, 0.25)',
            }}>
              <Bot size={13} color="#fff" />
            </div>
            <div style={{
              padding: '14px 20px', borderRadius: '16px 16px 16px 4px',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              display: 'flex', gap: '5px', alignItems: 'center',
            }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
                  animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}
        <div ref={chatEnd} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '16px 24px', borderTop: '1px solid var(--border)',
        display: 'flex', gap: '10px',
        background: 'rgba(15, 20, 35, 0.5)',
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{
          flex: 1, position: 'relative',
          borderRadius: 'var(--radius-sm)',
          boxShadow: inputFocused ? '0 0 0 2px rgba(37, 112, 255, 0.2), 0 0 16px rgba(37, 112, 255, 0.1)' : 'none',
          transition: 'box-shadow 0.25s ease',
        }}>
          <input
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Type a message..."
            style={{ ...S.input, width: '100%' }}
          />
        </div>
        <button onClick={send} disabled={sending || !input.trim()} style={{
          ...S.btnPrimary,
          opacity: sending || !input.trim() ? 0.4 : 1,
          padding: '10px 16px',
        }}><Send size={16} /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelsPanel
// ---------------------------------------------------------------------------

function ChannelsPanel({ instanceId }: { instanceId: string }) {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [connecting, setConnecting] = useState(false);
  const [hoveredChannel, setHoveredChannel] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/instances/${instanceId}/channels`);
      const d = await r.json();
      setChannels(d.channels || []);
    } catch { /* noop */ }
  }, [instanceId]);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const connect = async (channel: string) => {
    setConnecting(true);
    try {
      await authFetch(`${API}/api/instances/${instanceId}/channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ...formData }),
      });
      setExpandedChannel(null);
      setFormData({});
      fetchChannels();
    } catch { /* noop */ } finally { setConnecting(false); }
  };

  const disconnect = async (channel: string) => {
    try {
      await authFetch(`${API}/api/instances/${instanceId}/channels/${channel}`, { method: 'DELETE' });
      fetchChannels();
    } catch { /* noop */ }
  };

  const channelKeys = Object.keys(CHANNEL_META);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>Channels</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Connect messaging platforms to this instance</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
        {channelKeys.map(ch => {
          const meta = CHANNEL_META[ch];
          const connected = channels.find(c => c.channel === ch && c.status === 'connected');
          const isExpanded = expandedChannel === ch;
          const isHovered = hoveredChannel === ch;
          const brandColor = CHANNEL_BRAND_COLORS[ch] || 'var(--accent)';

          return (
            <div
              key={ch}
              onMouseEnter={() => setHoveredChannel(ch)}
              onMouseLeave={() => setHoveredChannel(null)}
              style={{
                ...S.card, padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden',
                filter: isHovered ? 'brightness(1.08)' : 'brightness(1)',
                boxShadow: isHovered ? 'var(--shadow)' : 'var(--shadow-sm)',
                transition: 'all 0.2s ease',
              }}
            >
              {/* Brand accent top line */}
              <div style={{
                height: '3px',
                background: connected
                  ? `linear-gradient(90deg, ${brandColor}, ${brandColor}88)`
                  : `linear-gradient(90deg, ${brandColor}44, ${brandColor}22)`,
                transition: 'all 0.3s ease',
              }} />

              <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '12px',
                    background: connected ? `${brandColor}18` : 'var(--surface2)',
                    color: connected ? brandColor : 'var(--text-secondary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${connected ? `${brandColor}30` : 'var(--border-light)'}`,
                    transition: 'all 0.2s ease',
                  }}>{CHANNEL_ICONS[ch] || <Globe size={16} />}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {meta.label}
                      {connected && (
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%', background: 'var(--pass)',
                          animation: 'livePulse 2s infinite',
                        }} />
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5', marginTop: '2px' }}>{meta.description}</div>
                  </div>
                </div>

                {connected ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', borderRadius: '10px',
                    background: 'var(--pass-light)', border: '1px solid rgba(34, 197, 94, 0.15)',
                  }}>
                    <span style={{
                      fontSize: '12px', fontWeight: 600, color: 'var(--pass)',
                      display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                      <Check size={14} /> Connected
                    </span>
                    <button onClick={() => disconnect(ch)} style={{
                      ...S.btnGhost, padding: '5px 10px', fontSize: '11px',
                      color: 'var(--block)', borderColor: 'rgba(239, 68, 68, 0.2)',
                      background: 'var(--block-light)',
                    }}>Disconnect</button>
                  </div>
                ) : isExpanded ? (
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: '8px',
                    animation: 'fadeIn 0.2s ease-out',
                  }}>
                    {meta.fields.map(f => (
                      <input
                        key={f}
                        value={formData[f] || ''}
                        onChange={e => setFormData({ ...formData, [f]: e.target.value })}
                        placeholder={f.replace(/_/g, ' ')}
                        type="password"
                        style={{ ...S.input, fontSize: '12px', padding: '8px 12px' }}
                      />
                    ))}
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => connect(ch)} disabled={connecting} style={{
                        ...S.btnPrimary, flex: 1, padding: '8px', fontSize: '12px', justifyContent: 'center',
                      }}>{connecting ? 'Connecting...' : 'Connect'}</button>
                      <button onClick={() => { setExpandedChannel(null); setFormData({}); }} style={{
                        ...S.btnGhost, padding: '8px 12px', fontSize: '12px',
                      }}><X size={14} /></button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setExpandedChannel(ch)} style={{
                    ...S.btnGhost, width: '100%', justifyContent: 'center', fontSize: '12px', padding: '9px',
                    display: 'flex', alignItems: 'center', gap: '6px',
                  }}>
                    <Plus size={14} /> Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 3: Workflows
// ---------------------------------------------------------------------------

function WorkflowsScreen({ selectedInstanceId, instances }: { selectedInstanceId: string | null; instances: Instance[] }) {
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateFilter, setTemplateFilter] = useState('All');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [loadingTasks, setLoadingTasks] = useState(false);
  const templatesFetched = useRef(false);

  const instanceId = selectedInstanceId;
  const inst = instances.find(i => i.id === instanceId);

  // Fetch templates once
  useEffect(() => {
    if (templatesFetched.current) return;
    templatesFetched.current = true;
    authFetch(`${API}/api/templates`).then(r => r.json()).then(d => {
      setTemplates(d.templates || []);
    }).catch(() => { /* noop */ });
  }, []);

  // Fetch tasks when instance changes
  const fetchTasks = useCallback(async () => {
    if (!instanceId) return;
    setLoadingTasks(true);
    try {
      const r = await authFetch(`${API}/api/instances/${instanceId}/workflows`);
      const d = await r.json();
      setTasks(d.tasks || []);
    } catch { /* noop */ } finally { setLoadingTasks(false); }
  }, [instanceId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const createTask = async (title: string, description?: string, templateId?: string, taskChannels?: string[], schedule?: string) => {
    if (!instanceId) return;
    try {
      const r = await authFetch(`${API}/api/instances/${instanceId}/workflows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, description: description || '', status: 'todo',
          template_id: templateId || null, channels: taskChannels || [], schedule: schedule || null,
        }),
      });
      if (r.ok) fetchTasks();
    } catch { /* noop */ }
  };

  const updateTask = async (taskId: string, updates: Record<string, string>) => {
    if (!instanceId) return;
    try {
      await authFetch(`${API}/api/instances/${instanceId}/workflows/${taskId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      fetchTasks();
    } catch { /* noop */ }
  };

  const deleteTask = async (taskId: string) => {
    if (!instanceId) return;
    try {
      await authFetch(`${API}/api/instances/${instanceId}/workflows/${taskId}`, { method: 'DELETE' });
      fetchTasks();
    } catch { /* noop */ }
  };

  const handleAddTask = (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    createTask(newTitle.trim(), newDesc.trim());
    setNewTitle('');
    setNewDesc('');
    setShowAddForm(false);
  };

  const addTemplate = (t: Template) => {
    createTask(t.title, t.description, t.id, t.channels, t.schedule);
  };

  if (!instanceId || !inst) {
    return (
      <div style={{
        height: 'calc(100vh - 60px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 50%, rgba(37, 112, 255, 0.03), transparent 60%)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', animation: 'fadeIn 0.5s ease-out' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '20px', margin: '0 auto 16px',
            background: 'var(--surface2)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Columns3 size={28} style={{ opacity: 0.3, color: 'var(--accent)' }} />
          </div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>No instance selected</div>
          <div style={{ fontSize: '13px' }}>Go to the Instances tab to select or create one first.</div>
        </div>
      </div>
    );
  }

  const columns: { key: WorkflowTask['status']; label: string; color: string; gradient: string }[] = [
    { key: 'todo', label: 'To Do', color: 'var(--text-secondary)', gradient: 'linear-gradient(135deg, #4a5268, #6b7280)' },
    { key: 'in_progress', label: 'In Progress', color: 'var(--warn)', gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)' },
    { key: 'done', label: 'Done', color: 'var(--pass)', gradient: 'linear-gradient(135deg, #22c55e, #4ade80)' },
  ];

  const statusOrder: WorkflowTask['status'][] = ['todo', 'in_progress', 'done'];

  const filterCategories = ['All', 'Calendar & Email', 'Web Search', 'Developer'];
  const filteredTemplates = templateFilter === 'All'
    ? templates
    : templates.filter(t => t.category === templateFilter);

  const taskTemplateIds = new Set(tasks.filter(t => t.template_id).map(t => t.template_id));

  const CATEGORY_COLORS: Record<string, string> = {
    'Calendar & Email': '#2570ff',
    'Web Search': '#0069ff',
    'Developer': '#22c55e',
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
      {/* LEFT: Kanban */}
      <div style={{ flex: '1 1 65%', overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '10px',
            background: 'linear-gradient(135deg, #0069ff, #2570ff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 12px rgba(37, 112, 255, 0.2)',
          }}>
            <LayoutGrid size={16} style={{ color: '#fff' }} />
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Workflows</h2>
          <span style={{
            fontSize: '12px', color: 'var(--text-muted)', background: 'var(--surface2)',
            padding: '3px 12px', borderRadius: '10px', fontWeight: 500,
            border: '1px solid var(--border-light)',
          }}>{inst.name}</span>
          {loadingTasks && <Loader size={16} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite' }} />}
        </div>

        <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
          {columns.map(col => {
            const colTasks = tasks.filter(t => t.status === col.key);
            return (
              <div key={col.key} style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                background: 'var(--surface)', borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                minHeight: '200px', overflow: 'hidden',
              }}>
                {/* Column header with gradient bar */}
                <div style={{
                  background: col.gradient, padding: '2px',
                }} />
                <div style={{
                  padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '8px',
                  borderBottom: '1px solid var(--border-light)',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: col.color }} />
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>{col.label}</span>
                  <span style={{
                    fontSize: '11px', fontWeight: 700,
                    background: 'var(--surface2)',
                    padding: '2px 8px', borderRadius: '8px', color: 'var(--text-muted)',
                    border: '1px solid var(--border-light)',
                  }}>{colTasks.length}</span>
                </div>

                {/* Cards */}
                <div style={{ flex: 1, overflow: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {colTasks.length === 0 && (
                    <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                      No tasks
                    </div>
                  )}
                  {colTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      statusOrder={statusOrder}
                      onUpdate={updateTask}
                      onDelete={deleteTask}
                    />
                  ))}
                </div>

                {/* Add button for todo */}
                {col.key === 'todo' && (
                  <div style={{ padding: '10px' }}>
                    {showAddForm ? (
                      <form onSubmit={handleAddTask} style={{
                        ...S.card, padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px',
                        animation: 'fadeIn 0.2s ease-out',
                      }}>
                        <input
                          value={newTitle} onChange={e => setNewTitle(e.target.value)}
                          placeholder="Task title" autoFocus
                          style={{ ...S.input, fontSize: '12px', padding: '8px 10px' }}
                        />
                        <input
                          value={newDesc} onChange={e => setNewDesc(e.target.value)}
                          placeholder="Description (optional)"
                          style={{ ...S.input, fontSize: '12px', padding: '8px 10px' }}
                        />
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button type="submit" disabled={!newTitle.trim()} style={{
                            ...S.btnPrimary, flex: 1, padding: '7px', fontSize: '12px', justifyContent: 'center',
                            opacity: !newTitle.trim() ? 0.5 : 1,
                          }}>Add</button>
                          <button type="button" onClick={() => { setShowAddForm(false); setNewTitle(''); setNewDesc(''); }} style={{
                            ...S.btnGhost, padding: '7px 10px', fontSize: '12px',
                          }}><X size={14} /></button>
                        </div>
                      </form>
                    ) : (
                      <button onClick={() => setShowAddForm(true)} style={{
                        width: '100%', padding: '9px', borderRadius: '10px', fontSize: '12px', fontWeight: 500,
                        background: 'transparent', border: '1px dashed var(--border)',
                        color: 'var(--text-muted)', cursor: 'pointer', display: 'flex',
                        alignItems: 'center', justifyContent: 'center', gap: '5px',
                        transition: 'all 0.2s ease',
                      }}><Plus size={14} /> Add task</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT: Templates */}
      <div style={{
        flex: '0 0 35%', borderLeft: '1px solid var(--border)', overflow: 'auto',
        padding: '24px',
        background: 'rgba(15, 20, 35, 0.4)',
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <Sparkles size={16} style={{ color: 'var(--accent)' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 700 }}>Templates</h3>
          <span style={{
            fontSize: '11px', fontWeight: 700, background: 'var(--accent-light)',
            padding: '2px 8px', borderRadius: '8px', color: 'var(--accent)',
          }}>{templates.length}</span>
        </div>

        <div style={{ display: 'flex', gap: '6px', marginBottom: '18px', flexWrap: 'wrap' }}>
          {filterCategories.map(cat => {
            const count = cat === 'All' ? templates.length : templates.filter(t => t.category === cat).length;
            return (
              <button key={cat} onClick={() => setTemplateFilter(cat)} style={{
                padding: '5px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 500,
                background: templateFilter === cat ? 'linear-gradient(135deg, #0069ff, #2570ff)' : 'var(--surface2)',
                color: templateFilter === cat ? '#fff' : 'var(--text-secondary)',
                border: templateFilter === cat ? 'none' : '1px solid var(--border-light)',
                cursor: 'pointer', transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', gap: '5px',
                boxShadow: templateFilter === cat ? '0 0 8px rgba(37, 112, 255, 0.3)' : 'none',
              }}>
                {cat}
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  background: templateFilter === cat ? 'rgba(255,255,255,0.2)' : 'var(--surface)',
                  padding: '1px 6px', borderRadius: '6px',
                  color: templateFilter === cat ? '#fff' : 'var(--text-muted)',
                }}>{count}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {filteredTemplates.map(t => {
            const alreadyAdded = taskTemplateIds.has(t.id);
            const catColor = CATEGORY_COLORS[t.category] || 'var(--accent)';
            return (
              <div key={t.id} style={{
                ...S.card, padding: '0', overflow: 'hidden',
                transition: 'all 0.2s ease',
              }}>
                {/* Category color bar */}
                <div style={{ height: '2px', background: `${catColor}60` }} />
                <div style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '10px', flexShrink: 0,
                      background: `${catColor}18`, color: catColor,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: `1px solid ${catColor}25`,
                    }}>{WORKFLOW_ICONS[t.icon] || <Zap size={16} />}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '3px' }}>{t.title}</div>
                      <div style={{
                        fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>{t.description}</div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        {t.schedule && (
                          <span style={{
                            fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                            background: 'var(--surface2)', color: 'var(--text-muted)',
                            display: 'flex', alignItems: 'center', gap: '3px',
                            border: '1px solid var(--border-light)',
                          }}><Clock size={10} /> {t.schedule}</span>
                        )}
                        {t.channels.map(ch => (
                          <span key={ch} style={{
                            display: 'flex', alignItems: 'center', color: 'var(--text-muted)',
                          }}>{CHANNEL_ICONS[ch] || <Globe size={12} />}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: '14px' }}>
                    {alreadyAdded ? (
                      <span style={{
                        fontSize: '12px', fontWeight: 600, color: 'var(--pass)',
                        display: 'flex', alignItems: 'center', gap: '5px',
                      }}><Check size={14} /> Added</span>
                    ) : (
                      <button onClick={() => addTemplate(t)} style={{
                        ...S.btnPrimary, width: '100%', justifyContent: 'center', fontSize: '12px', padding: '8px',
                      }}><Plus size={14} /> Add as Task</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredTemplates.length === 0 && (
            <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              No templates in this category
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskCard
// ---------------------------------------------------------------------------

function TaskCard({ task, statusOrder, onUpdate, onDelete }: {
  task: WorkflowTask;
  statusOrder: WorkflowTask['status'][];
  onUpdate: (id: string, updates: Record<string, string>) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const idx = statusOrder.indexOf(task.status);
  const canLeft = idx > 0;
  const canRight = idx < statusOrder.length - 1;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--surface2)',
        borderRadius: '10px',
        border: '1px solid var(--border)',
        padding: '14px',
        position: 'relative',
        transition: 'all 0.2s ease',
        boxShadow: hovered ? 'var(--shadow)' : 'var(--shadow-sm)',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '4px', paddingRight: '28px' }}>{task.title}</div>
      {task.description && (
        <div style={{
          fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '8px',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{task.description}</div>
      )}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        {task.schedule && (
          <span style={{
            fontSize: '10px', padding: '2px 7px', borderRadius: '6px',
            background: 'var(--surface)', color: 'var(--text-muted)',
            display: 'flex', alignItems: 'center', gap: '3px',
            border: '1px solid var(--border-light)',
          }}><Clock size={10} /> {task.schedule}</span>
        )}
        {task.channels.map(ch => (
          <span key={ch} style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>
            {CHANNEL_ICONS[ch] || <Globe size={12} />}
          </span>
        ))}
      </div>

      {/* Hover controls */}
      {hovered && (
        <div style={{
          position: 'absolute', top: '10px', right: '10px',
          display: 'flex', gap: '3px',
          animation: 'fadeIn 0.15s ease-out',
        }}>
          {canLeft && (
            <button onClick={() => onUpdate(task.id, { status: statusOrder[idx - 1] })} style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px',
              padding: '4px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex',
              transition: 'all 0.15s ease',
            }} title="Move left"><ChevronLeft size={13} /></button>
          )}
          {canRight && (
            <button onClick={() => onUpdate(task.id, { status: statusOrder[idx + 1] })} style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px',
              padding: '4px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex',
              transition: 'all 0.15s ease',
            }} title="Move right"><ChevronRight size={13} /></button>
          )}
          <button onClick={() => onDelete(task.id)} style={{
            background: 'var(--block-light)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '6px',
            padding: '4px', cursor: 'pointer', color: 'var(--block)', display: 'flex',
            transition: 'all 0.15s ease',
          }} title="Delete"><Trash2 size={13} /></button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 4: Dashboard
// ---------------------------------------------------------------------------

function DashboardScreen() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Load initial events
  useEffect(() => {
    authFetch(`${API}/api/events/recent`).then(r => r.json()).then(d => {
      setEvents(Array.isArray(d) ? d : []);
    }).catch(() => { /* noop */ });
  }, []);

  // SSE stream
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API}/api/events/stream`);
      es.onmessage = (e) => {
        try {
          const ev: AuditEvent = JSON.parse(e.data);
          setEvents(prev => [ev, ...prev].slice(0, 200));
        } catch { /* noop */ }
      };
    } catch { /* noop */ }
    return () => { es?.close(); };
  }, []);

  const passed = events.filter(e => e.verdict === 'pass').length;
  const blocked = events.filter(e => e.verdict === 'block').length;
  const redacted = events.filter(e => e.verdict === 'redact').length;

  const policies = [
    {
      icon: <Shield size={24} />,
      title: 'Prompt Injection Shield',
      desc: 'Detects and blocks prompt injection attacks, jailbreak attempts, and adversarial inputs before they reach the model.',
      color: '#2570ff',
      gradient: 'linear-gradient(135deg, #0069ff, #3b82f6)',
    },
    {
      icon: <Eye size={24} />,
      title: 'PII Firewall',
      desc: 'Automatically identifies and redacts personally identifiable information including emails, phone numbers, SSNs, and addresses.',
      color: '#f59e0b',
      gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
    },
    {
      icon: <AlertTriangle size={24} />,
      title: 'Malicious Command Block',
      desc: 'Prevents execution of dangerous system commands, SQL injection attempts, and unauthorized file access operations.',
      color: '#ef4444',
      gradient: 'linear-gradient(135deg, #ef4444, #f87171)',
    },
  ];

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
      {/* Left: Guardrail policies */}
      <div style={{
        width: '420px', borderRight: '1px solid var(--border)', overflow: 'auto', padding: '28px',
        background: 'rgba(15, 20, 35, 0.3)',
      }}>
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <div style={{
              width: 32, height: 32, borderRadius: '10px',
              background: 'linear-gradient(135deg, #0069ff, #2570ff)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 12px rgba(37, 112, 255, 0.2)',
            }}>
              <Shield size={16} style={{ color: '#fff' }} />
            </div>
            <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Guardrail Policies</h2>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: '1.6' }}>Active protection layers for all instances</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {policies.map((p, i) => (
            <div key={i} style={{
              ...S.card, padding: '0', overflow: 'hidden',
              transition: 'all 0.2s ease',
            }}>
              <div style={{ padding: '22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px' }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: '14px',
                    background: p.gradient,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff',
                    boxShadow: `0 4px 16px ${p.color}33`,
                  }}>{p.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '2px' }}>{p.title}</div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%', background: 'var(--pass)',
                        animation: 'livePulse 2s infinite',
                      }} />
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--pass)' }}>Active</span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.7' }}>{p.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Audit feed */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '28px 28px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
            <Activity size={20} style={{ color: 'var(--accent)' }} />
            <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Live Audit Feed</h2>
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: 'var(--pass)',
              animation: 'livePulse 2s infinite', marginLeft: '4px',
            }} />
          </div>

          {/* Stats bar with BIG numbers */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '24px' }}>
            {[
              { label: 'Passed', value: passed, color: 'var(--pass)', gradient: 'linear-gradient(135deg, #22c55e, #4ade80)', icon: <Check size={18} /> },
              { label: 'Blocked', value: blocked, color: 'var(--block)', gradient: 'linear-gradient(135deg, #ef4444, #f87171)', icon: <X size={18} /> },
              { label: 'Redacted', value: redacted, color: 'var(--warn)', gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)', icon: <EyeOff size={18} /> },
            ].map(s => (
              <div key={s.label} style={{
                ...S.card, flex: 1, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: '14px',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '12px',
                  background: s.gradient,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff',
                  boxShadow: `0 4px 12px ${s.color}33`,
                }}>{s.icon}</div>
                <div>
                  <div style={{
                    fontSize: '28px', fontWeight: 700, lineHeight: '1',
                    color: 'var(--text)',
                  }}>{s.value}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500, marginTop: '2px' }}>{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
          {events.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '48px', color: 'var(--text-muted)',
              animation: 'fadeIn 0.5s ease-out',
            }}>
              <div style={{
                width: 64, height: 64, borderRadius: '20px', margin: '0 auto 16px',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Shield size={28} style={{ opacity: 0.3, color: 'var(--accent)' }} />
              </div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>No audit events yet</div>
              <div style={{ fontSize: '13px' }}>Events will appear here in real-time as guardrails process messages</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {events.map(ev => {
                const isExpanded = expandedEventId === ev.id;
                return (
                  <div
                    key={ev.id}
                    onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                    style={{
                      ...S.card, padding: '0', overflow: 'hidden',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      display: 'flex',
                    }}
                  >
                    {/* Left color border */}
                    <div style={{
                      width: '4px', flexShrink: 0,
                      background: verdictColor(ev.verdict),
                    }} />

                    <div style={{ flex: 1, padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '8px', flexShrink: 0,
                          background: verdictBg(ev.verdict), color: verdictColor(ev.verdict),
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {ev.verdict === 'pass' ? <Check size={14} /> : ev.verdict === 'block' ? <X size={14} /> : <EyeOff size={14} />}
                        </div>
                        <span style={{
                          fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px',
                          background: verdictBg(ev.verdict), color: verdictColor(ev.verdict), textTransform: 'uppercase',
                          letterSpacing: '0.3px',
                        }}>{ev.verdict}</span>
                        <span style={{
                          fontSize: '11px', color: 'var(--text-muted)',
                          display: 'flex', alignItems: 'center', gap: '4px',
                        }}>
                          {ev.direction === 'inbound' ? <ArrowRight size={10} /> : <ArrowRight size={10} style={{ transform: 'rotate(180deg)' }} />}
                          {ev.direction}
                        </span>
                        {/* Model attribution chip */}
                        {ev.model_used && (
                          <span style={{
                            fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                            background: 'rgba(37, 112, 255, 0.1)', color: '#2570ff',
                            border: '1px solid rgba(37, 112, 255, 0.15)',
                            fontWeight: 500,
                            display: 'flex', alignItems: 'center', gap: '3px',
                          }}>
                            <Cpu size={9} />
                            {ev.model_used}
                          </span>
                        )}
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{timeSince(ev.timestamp)}</span>
                      </div>
                      <div style={{
                        fontSize: '13px', color: 'var(--text)', lineHeight: '1.5',
                        whiteSpace: isExpanded ? 'normal' : 'nowrap',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        textOverflow: isExpanded ? 'unset' : 'ellipsis',
                      }}>{ev.original_preview}</div>
                      {ev.violation_types.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', marginTop: '8px', flexWrap: 'wrap' }}>
                          {ev.violation_types.map((v, i) => (
                            <span key={i} style={{
                              fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                              background: 'var(--surface2)', color: 'var(--text-muted)',
                              border: '1px solid var(--border-light)',
                            }}>{v}</span>
                          ))}
                        </div>
                      )}
                      {isExpanded && ev.reasoning && (
                        <div style={{
                          fontSize: '12px', color: 'var(--text-secondary)', marginTop: '10px', lineHeight: '1.6',
                          padding: '10px 14px', borderRadius: '8px',
                          background: 'var(--surface2)', border: '1px solid var(--border-light)',
                          animation: 'fadeIn 0.2s ease-out',
                        }}>
                          <span style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Reasoning</span>
                          <div style={{ marginTop: '4px' }}>{ev.reasoning}</div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App (root)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Login Screen
// ---------------------------------------------------------------------------
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (r.ok && d.token) {
        sessionStorage.setItem('assistantx_token', d.token);
        onLogin();
      } else {
        setError(d.error || 'Invalid password');
      }
    } catch {
      setError('Connection failed');
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'var(--card)', borderRadius: 16, padding: 40,
        border: '1px solid var(--border)', minWidth: 360,
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 700, color: '#fff', marginBottom: 12,
          }}>O</div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: 22 }}>Ombre</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            AI Firewall for OpenClaw
          </p>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter admin password"
            autoFocus
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg)',
              color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={loading || !password}
          style={{
            padding: '10px 0', borderRadius: 10, border: 'none',
            background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
            color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            opacity: loading || !password ? 0.5 : 1,
          }}
        >
          {loading ? 'Authenticating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
export default function App() {
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem('assistantx_token'));

  if (!authed) {
    return <LoginScreen onLogin={() => setAuthed(true)} />;
  }

  return <AuthedApp />;
}

// ---------------------------------------------------------------------------
// Dead-Man Switch Screen
// ---------------------------------------------------------------------------

interface SwitchStatus {
  configured: boolean;
  state: 'armed' | 'grace' | 'triggered' | 'completed' | 'disarmed';
  last_checkin: number | null;
  last_checkin_ago_seconds: number | null;
  next_checkin_due: number | null;
  overdue_by_seconds: number;
  grace_expires_at: number | null;
  grace_remaining_seconds: number | null;
  checkins_total: number;
  trigger_time: number | null;
  distribution_log: string[];
  trusted_contacts: number;
  secure_destinations: number;
}

interface VaultConnection {
  connection: string;
  scopes: string[];
  expires_in_seconds: number;
  valid: boolean;
}

function DeadManScreen({ selectedInstanceId, instances }: {
  selectedInstanceId: string | null;
  instances: Instance[];
}) {
  const instanceId = selectedInstanceId || instances[0]?.id || 'demo';
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [vault, setVault] = useState<VaultConnection[]>([]);
  const [checkinWord, setCheckinWord] = useState('alive');
  const [checkinResult, setCheckinResult] = useState<{ accepted: boolean; message: string } | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [simulateLoading, setSimulateLoading] = useState(false);
  const [countdown, setCountdown] = useState<string>('');

  // Setup form state
  const [setupForm, setSetupForm] = useState({
    checkin_interval_hours: 24,
    grace_period_hours: 2,
    checkin_word: 'alive',
    contact_name: '',
    contact_email: '',
    dest_name: 'Google Drive Mirror',
    dest_type: 'google_drive',
    dest_url: 'https://www.googleapis.com/drive/v3/files',
  });

  const fetchStatus = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/deadman/${instanceId}/status`);
      const d = await r.json();
      setStatus(d);
    } catch { /* noop */ }
  }, [instanceId]);

  const fetchVault = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/deadman/${instanceId}/vault`);
      const d = await r.json();
      setVault(d.active_connections || []);
    } catch { /* noop */ }
  }, [instanceId]);

  useEffect(() => {
    fetchStatus();
    fetchVault();
    const iv = setInterval(() => { fetchStatus(); fetchVault(); }, 3000);
    return () => clearInterval(iv);
  }, [fetchStatus, fetchVault]);

  // Countdown timer
  useEffect(() => {
    const tick = () => {
      if (!status?.next_checkin_due) return;
      const now = Date.now() / 1000;
      const diff = status.next_checkin_due - now;
      if (diff <= 0) { setCountdown('OVERDUE'); return; }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = Math.floor(diff % 60);
      setCountdown(`${h}h ${m}m ${s}s`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [status?.next_checkin_due]);

  const handleCheckin = async () => {
    setCheckinLoading(true);
    setCheckinResult(null);
    try {
      const r = await authFetch(`${API}/api/deadman/${instanceId}/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: checkinWord }),
      });
      const d = await r.json();
      setCheckinResult(d);
      fetchStatus();
    } catch { /* noop */ } finally { setCheckinLoading(false); }
  };

  const handleSetup = async () => {
    setSetupLoading(true);
    try {
      await authFetch(`${API}/api/deadman/${instanceId}/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkin_interval_hours: setupForm.checkin_interval_hours,
          grace_period_hours: setupForm.grace_period_hours,
          checkin_word: setupForm.checkin_word,
          trusted_contacts: setupForm.contact_email ? [{
            name: setupForm.contact_name || 'Trusted Contact',
            email: setupForm.contact_email,
            notify_on_grace: true,
            notify_on_trigger: true,
            can_rearm: true,
          }] : [],
          secure_destinations: [{
            name: setupForm.dest_name,
            type: setupForm.dest_type,
            url: setupForm.dest_url,
          }],
        }),
      });
      setShowSetup(false);
      fetchStatus();
      fetchVault();
    } catch { /* noop */ } finally { setSetupLoading(false); }
  };

  const handleSimulate = async (scenario: string) => {
    setSimulateLoading(true);
    try {
      await authFetch(`${API}/api/deadman/${instanceId}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      setTimeout(fetchStatus, 500);
    } catch { /* noop */ } finally { setSimulateLoading(false); }
  };

  const stateColor = (s: string) => {
    switch (s) {
      case 'armed': return '#22c55e';
      case 'grace': return '#f59e0b';
      case 'triggered': return '#ef4444';
      case 'completed': return '#6b7280';
      default: return '#6b7280';
    }
  };

  const stateLabel = (s: string) => {
    switch (s) {
      case 'armed': return '🛡 ARMED';
      case 'grace': return '⚠️ GRACE PERIOD';
      case 'triggered': return '🔴 TRIGGERED';
      case 'completed': return '✓ COMPLETED';
      case 'disarmed': return '○ DISARMED';
      default: return '— NOT CONFIGURED';
    }
  };

  const isTriggered = status?.state === 'triggered' || status?.state === 'completed';

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflow: 'auto', padding: '32px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
              <div style={{
                width: 40, height: 40, borderRadius: '12px',
                background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 20px rgba(124,58,237,0.4)',
              }}>
                <Lock size={18} color="#fff" />
              </div>
              <div>
                <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.3px' }}>
                  Dead-Man Switch
                </h1>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Powered by Auth0 Token Vault · instance: <code style={{ color: 'var(--text-secondary)' }}>{instanceId}</code>
                </p>
              </div>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '600px', lineHeight: '1.6' }}>
              You cannot surrender credentials you do not have. Auth0 Token Vault holds them.
              Miss a check-in and the protocol executes automatically — encrypt, distribute, notify, revoke.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button onClick={() => setShowSetup(!showSetup)} style={{ ...S.btnGhost, fontSize: '12px' }}>
              <AlertTriangle size={13} /> Configure
            </button>
            <button onClick={() => handleSimulate('trigger')} disabled={simulateLoading || !status?.configured} style={{
              ...S.btnGhost, fontSize: '12px', borderColor: 'rgba(239,68,68,0.4)', color: '#ef4444',
              opacity: simulateLoading || !status?.configured ? 0.4 : 1,
            }}>
              {simulateLoading ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={13} />}
              Simulate Trigger
            </button>
          </div>
        </div>

        {/* Setup form */}
        {showSetup && (
          <div style={{ ...S.card, padding: '24px', animation: 'fadeIn 0.2s ease-out', border: '1px solid rgba(124,58,237,0.3)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={15} style={{ color: '#a78bfa' }} /> Configure Switch
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              {[
                { label: 'Check-in Interval (hours)', key: 'checkin_interval_hours', type: 'number' },
                { label: 'Grace Period (hours)', key: 'grace_period_hours', type: 'number' },
                { label: 'Check-in Word', key: 'checkin_word', type: 'text' },
                { label: 'Trusted Contact Email', key: 'contact_email', type: 'email' },
                { label: 'Contact Name', key: 'contact_name', type: 'text' },
                { label: 'Destination URL', key: 'dest_url', type: 'text' },
              ].map(f => (
                <div key={f.key}>
                  <label style={S.label}>{f.label}</label>
                  <input
                    type={f.type}
                    value={(setupForm as any)[f.key]}
                    onChange={e => setSetupForm(prev => ({ ...prev, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value }))}
                    style={S.input}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleSetup} disabled={setupLoading} style={{ ...S.btnPrimary, background: 'linear-gradient(135deg, #7c3aed, #a855f7)' }}>
                {setupLoading ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />}
                Arm Switch
              </button>
              <button onClick={() => setShowSetup(false)} style={S.btnGhost}><X size={14} /> Cancel</button>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* State card */}
            <div style={{
              ...S.card,
              padding: '24px',
              border: `1px solid ${status?.configured ? stateColor(status.state) + '44' : 'var(--border)'}`,
              boxShadow: status?.configured ? `0 0 24px ${stateColor(status?.state || '')}18` : 'var(--shadow-sm)',
              position: 'relative', overflow: 'hidden',
            }}>
              {/* Glow bg */}
              {status?.configured && (
                <div style={{
                  position: 'absolute', inset: 0, opacity: 0.04,
                  background: `radial-gradient(circle at 30% 50%, ${stateColor(status.state)}, transparent 70%)`,
                  pointerEvents: 'none',
                }} />
              )}
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
                  Switch State
                </div>
                <div style={{
                  fontSize: '26px', fontWeight: 800, letterSpacing: '-0.5px',
                  color: status?.configured ? stateColor(status.state) : 'var(--text-muted)',
                  marginBottom: '16px',
                  fontFamily: 'monospace',
                }}>
                  {status?.configured ? stateLabel(status.state) : '— NOT CONFIGURED'}
                </div>

                {status?.configured && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {[
                        { label: 'Next check-in', value: countdown || '—', highlight: status.overdue_by_seconds > 0 },
                        { label: 'Total check-ins', value: String(status.checkins_total), highlight: false },
                        { label: 'Trusted contacts', value: String(status.trusted_contacts), highlight: false },
                        { label: 'Destinations', value: String(status.secure_destinations), highlight: false },
                      ].map(item => (
                        <div key={item.label} style={{
                          background: 'var(--surface2)', border: '1px solid var(--border)',
                          borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px',
                        }}>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>{item.label}</div>
                          <div style={{ fontSize: '16px', fontWeight: 700, color: item.highlight ? '#ef4444' : 'var(--text)', fontFamily: 'monospace' }}>{item.value}</div>
                        </div>
                      ))}
                    </div>

                    {status.state === 'grace' && status.grace_remaining_seconds !== null && (
                      <div style={{
                        background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                        borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px',
                      }}>
                        <AlertTriangle size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: '#fbbf24' }}>Grace Period Active</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {Math.floor(status.grace_remaining_seconds / 60)} minutes remaining. Check in now or the protocol activates.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {!status?.configured && (
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                    Configure the switch to get started. Set your check-in schedule, trusted contacts, and secure destinations.
                  </p>
                )}
              </div>
            </div>

            {/* Check-in card */}
            <div style={{ ...S.card, padding: '24px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>
                Send Check-In
              </div>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                <input
                  value={checkinWord}
                  onChange={e => setCheckinWord(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCheckin()}
                  placeholder="Check-in word..."
                  style={{ ...S.input, flex: 1, fontFamily: 'monospace' }}
                  disabled={isTriggered}
                />
                <button
                  onClick={handleCheckin}
                  disabled={checkinLoading || isTriggered || !status?.configured}
                  style={{
                    ...S.btnPrimary,
                    background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                    boxShadow: '0 2px 8px rgba(34,197,94,0.3)',
                    opacity: checkinLoading || isTriggered || !status?.configured ? 0.4 : 1,
                    padding: '10px 20px',
                  }}
                >
                  {checkinLoading
                    ? <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <Check size={15} />}
                  I'm alive
                </button>
              </div>

              {checkinResult && (
                <div style={{
                  padding: '10px 14px', borderRadius: '8px', fontSize: '12px',
                  background: checkinResult.accepted ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${checkinResult.accepted ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  color: checkinResult.accepted ? '#4ade80' : '#f87171',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  animation: 'fadeIn 0.2s ease-out',
                }}>
                  {checkinResult.accepted ? <Check size={13} /> : <X size={13} />}
                  {checkinResult.message}
                </div>
              )}

              <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
                <button onClick={() => handleSimulate('missed_checkin')} disabled={simulateLoading || !status?.configured} style={{
                  ...S.btnGhost, fontSize: '11px', opacity: simulateLoading || !status?.configured ? 0.4 : 1,
                }}>
                  Simulate Missed
                </button>
                <button onClick={() => handleSimulate('grace_expired')} disabled={simulateLoading || !status?.configured} style={{
                  ...S.btnGhost, fontSize: '11px', opacity: simulateLoading || !status?.configured ? 0.4 : 1,
                }}>
                  Simulate Grace Expired
                </button>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Token Vault connections */}
            <div style={{ ...S.card, padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                  Auth0 Token Vault
                </div>
                <div style={{
                  fontSize: '10px', background: 'rgba(124,58,237,0.15)', color: '#a78bfa',
                  border: '1px solid rgba(124,58,237,0.3)', borderRadius: '10px', padding: '2px 8px', fontWeight: 600,
                }}>
                  {vault.length} connection{vault.length !== 1 ? 's' : ''}
                </div>
              </div>

              {vault.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  <Database size={28} style={{ opacity: 0.2, marginBottom: '8px' }} />
                  <div>No active vault connections</div>
                  <div style={{ fontSize: '11px', marginTop: '4px' }}>Tokens are issued on demand when the protocol runs</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {vault.map((conn, i) => (
                    <div key={i} style={{
                      padding: '12px 14px', borderRadius: '8px',
                      background: 'var(--surface2)', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'flex-start', gap: '10px',
                    }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: '8px', flexShrink: 0,
                        background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Lock size={12} style={{ color: '#a78bfa' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)', fontFamily: 'monospace' }}>{conn.connection}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {conn.scopes.map((s, j) => (
                            <span key={j} style={{
                              background: 'var(--surface)', border: '1px solid var(--border-light)',
                              borderRadius: '4px', padding: '1px 6px', fontFamily: 'monospace',
                            }}>{s}</span>
                          ))}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: conn.valid ? '#4ade80' : '#f87171', fontWeight: 600, flexShrink: 0 }}>
                        {conn.expires_in_seconds === -1 ? 'persistent' : conn.valid ? `${Math.floor(conn.expires_in_seconds / 60)}m left` : 'expired'}
                      </div>
                    </div>
                  ))}
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.5' }}>
                    Raw credentials are never stored on this machine. Tokens are fetched from Auth0 Token Vault per-request and expire automatically.
                  </p>
                </div>
              )}
            </div>

            {/* Distribution log */}
            <div style={{ ...S.card, padding: '24px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>
                Protocol Log
              </div>

              {!status?.distribution_log?.length ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <Activity size={24} style={{ opacity: 0.2, marginBottom: '8px' }} />
                  <div>Protocol has not run yet</div>
                </div>
              ) : (
                <div style={{
                  background: '#0a0c14', border: '1px solid var(--border)',
                  borderRadius: '8px', padding: '14px', fontFamily: 'monospace',
                  fontSize: '11px', lineHeight: '1.8', color: '#a0aec0',
                  maxHeight: '280px', overflow: 'auto',
                }}>
                  {status.distribution_log.map((line, i) => (
                    <div key={i} style={{
                      color: line.includes('ERROR') ? '#f87171'
                        : line.includes('✓') || line.includes('COMPLETE') ? '#4ade80'
                        : line.includes('WARNING') ? '#fbbf24'
                        : line.includes('PROTOCOL ACTIVATED') || line.includes('TRIGGERED') ? '#f87171'
                        : '#a0aec0',
                    }}>{line}</div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Auth0 Token Vault explanation */}
        <div style={{
          ...S.card, padding: '20px 24px',
          background: 'rgba(124,58,237,0.05)',
          border: '1px solid rgba(124,58,237,0.2)',
          display: 'flex', alignItems: 'flex-start', gap: '16px',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '10px', flexShrink: 0,
            background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Lock size={16} style={{ color: '#a78bfa' }} />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#c4b5fd', marginBottom: '4px' }}>
              Why Auth0 Token Vault?
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.7', maxWidth: '800px' }}>
              Every other "secure" tool requires you to hold a key somewhere — a config file, a password manager, a seed phrase.
              Something that can be found, extracted, or coerced out of you. Auth0 Token Vault eliminates that.
              The agent is authorized to act. The human is not in possession of the authorization.
              When the Dead-Man Switch fires, it exchanges your Auth0 token for a scoped Google Drive token — write-once, 60 minutes.
              <strong style={{ color: '#a78bfa' }}> You cannot surrender credentials you do not have.</strong>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function AuthedApp() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(() => {
    try { return localStorage.getItem('assistantx-selected-instance') || null; } catch { return null; }
  });

  // Persist selected instance
  useEffect(() => {
    if (selectedInstanceId) localStorage.setItem('assistantx-selected-instance', selectedInstanceId);
    else localStorage.removeItem('assistantx-selected-instance');
  }, [selectedInstanceId]);

  // Fetch instances & poll
  const fetchInstances = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/instances`);
      const d = await r.json();
      setInstances(Array.isArray(d) ? d : []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    fetchInstances();
    const iv = setInterval(fetchInstances, 4000);
    return () => clearInterval(iv);
  }, [fetchInstances]);

  const handleCreated = (inst: Instance) => {
    setSelectedInstanceId(inst.id);
    fetchInstances();
    setScreen('instances');
  };

  const hasRunning = instances.some(i => i.status === 'running');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <NavBar
        screen={screen}
        setScreen={setScreen}
        instanceCount={instances.length}
        hasRunning={hasRunning}
      />
      {screen === 'setup' && <SetupScreen onCreated={handleCreated} />}
      {screen === 'instances' && (
        <InstancesScreen
          instances={instances}
          selectedId={selectedInstanceId}
          onSelect={setSelectedInstanceId}
          onRefresh={fetchInstances}
        />
      )}
      {screen === 'workflows' && (
        <WorkflowsScreen
          selectedInstanceId={selectedInstanceId}
          instances={instances}
        />
      )}
      {screen === 'dashboard' && <DashboardScreen />}
      {screen === 'deadman' && (
        <DeadManScreen selectedInstanceId={selectedInstanceId} instances={instances} />
      )}
    </div>
  );
}
