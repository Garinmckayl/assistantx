import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Shield, MessageSquare, Send,
  Bot, Activity, Eye, EyeOff, Check, X, Loader,
  Lock, AlertTriangle,
  Sparkles, ArrowRight,
  Database, Wifi, WifiOff,
  Link2, Unlink, RefreshCw,
  Mail, Calendar, Github, MessageCircle, FileText,
  KeyRound, ToggleLeft, ToggleRight,
  LogOut,
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

interface VaultConnection {
  connection: string;
  scopes: string[];
  expires_in_seconds: number;
  valid: boolean;
}

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

type Screen = 'chat' | 'services' | 'safety' | 'activity' | 'permissions';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const API = '';

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
    background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '13px',
    border: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.2s ease',
    boxShadow: '0 2px 8px rgba(124, 58, 237, 0.25)',
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
};

// ---------------------------------------------------------------------------
// Service definitions for Connected Services
// ---------------------------------------------------------------------------

interface ServiceDef {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  color: string;
  scopes: string[];
  connection: string; // Token Vault connection type
}

const SERVICES: ServiceDef[] = [
  {
    id: 'gmail', name: 'Gmail', description: 'Read and send email on your behalf',
    icon: <Mail size={20} />, color: '#EA4335',
    scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
    connection: 'google-oauth2',
  },
  {
    id: 'calendar', name: 'Google Calendar', description: 'View and manage your calendar events',
    icon: <Calendar size={20} />, color: '#4285F4',
    scopes: ['calendar.readonly', 'calendar.events'],
    connection: 'google-oauth2',
  },
  {
    id: 'slack', name: 'Slack', description: 'Send messages and manage channels',
    icon: <MessageCircle size={20} />, color: '#4A154B',
    scopes: ['chat:write', 'channels:read', 'users:read'],
    connection: 'slack',
  },
  {
    id: 'github', name: 'GitHub', description: 'Access repositories and create issues',
    icon: <Github size={20} />, color: '#f0f6fc',
    scopes: ['repo', 'read:org', 'read:user'],
    connection: 'github',
  },
  {
    id: 'drive', name: 'Google Drive', description: 'Store and retrieve files securely',
    icon: <FileText size={20} />, color: '#0F9D58',
    scopes: ['drive.file', 'drive.readonly'],
    connection: 'google-oauth2',
  },
];

// ---------------------------------------------------------------------------
// NavBar
// ---------------------------------------------------------------------------

function NavBar({
  screen,
  setScreen,
  isConnected,
  onLogout,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  isConnected: boolean;
  onLogout: () => void;
}) {
  const tabs: { key: Screen; label: string; icon: ReactNode }[] = [
    { key: 'chat', label: 'Chat', icon: <MessageSquare size={14} /> },
    { key: 'services', label: 'Services', icon: <Link2 size={14} /> },
    { key: 'safety', label: 'Safety', icon: <Shield size={14} /> },
    { key: 'activity', label: 'Activity', icon: <Activity size={14} /> },
    { key: 'permissions', label: 'Permissions', icon: <KeyRound size={14} /> },
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
          background: 'linear-gradient(135deg, #7c3aed, #6d28d9, #7c3aed)',
          backgroundSize: '200% 200%',
          animation: 'gradientBorder 4s ease infinite',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: '16px',
          boxShadow: '0 0 16px rgba(124, 58, 237, 0.3)',
        }}>
          <span style={{ fontWeight: 800, fontSize: '13px', color: '#fff', fontFamily: 'Inter, sans-serif', letterSpacing: '-0.5px' }}>AX</span>
        </div>
        <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text)', letterSpacing: '-0.3px' }}>
          AssistantX
        </span>
        <div style={{
          fontSize: '10px', fontWeight: 600, color: '#6d28d9',
          background: 'rgba(124, 58, 237, 0.12)',
          padding: '3px 10px', borderRadius: '10px',
          letterSpacing: '0.4px', textTransform: 'uppercase',
          border: '1px solid rgba(124, 58, 237, 0.2)',
          animation: 'livePulse 3s ease-in-out infinite',
          display: 'flex', alignItems: 'center', gap: '5px',
        }}>
          <Lock size={10} />
          Token Vault
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
              background: isActive ? 'linear-gradient(135deg, #7c3aed, #6d28d9)' : 'transparent',
              color: isActive ? '#fff' : '#c8d4e8',
              border: 'none', cursor: 'pointer',
              transition: 'all 0.2s ease',
              display: 'flex', alignItems: 'center', gap: '6px',
              boxShadow: isActive ? '0 0 12px rgba(124, 58, 237, 0.4)' : 'none',
            }}>
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Right: Connection status + logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '12px', color: isConnected ? 'var(--pass)' : 'var(--text-muted)',
          fontWeight: 500,
        }}>
          {isConnected ? (
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
        <button onClick={onLogout} title="Sign out" style={{
          background: 'transparent', border: '1px solid var(--border)',
          borderRadius: '8px', padding: '6px 10px', cursor: 'pointer',
          color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '12px', fontWeight: 500, transition: 'all 0.2s ease',
        }}>
          <LogOut size={14} />
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Chat Screen (primary interface)
// ---------------------------------------------------------------------------

function ChatScreen({ instanceId }: { instanceId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    setMessages(loadChat(instanceId));
  }, [instanceId]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-welcome on first visit
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const existing = loadChat(instanceId);
    if (existing.length > 0) return;
    const welcomeMsg: ChatMessage = {
      id: uid(), role: 'assistant',
      content: "Hello! I'm your AssistantX AI assistant. I can help you with tasks across your connected services -- reading emails, managing your calendar, searching documents, and more. All interactions are protected by security guardrails, and I never see your raw credentials.\n\nWhat can I help you with?",
      ts: Date.now(),
    };
    setMessages([welcomeMsg]);
    saveChat(instanceId, [welcomeMsg]);
  }, [instanceId]);

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
      const errMsg: ChatMessage = { id: uid(), role: 'assistant', content: 'I had trouble processing that. Please try again.', ts: Date.now() };
      const updated = [...next, errMsg];
      setMessages(updated);
      saveChat(instanceId, updated);
    } finally { setSending(false); }
  };

  return (
    <div style={{ height: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Chat messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ maxWidth: '800px', width: '100%', margin: '0 auto', padding: '0 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {messages.map(m => (
            <div key={m.id} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              display: 'flex',
              flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
              gap: '10px',
              alignItems: 'flex-start',
              animation: 'fadeIn 0.3s ease-out',
            }}>
              {/* Avatar */}
              <div style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: m.role === 'user'
                  ? 'linear-gradient(135deg, #6d28d9, #a78bfa)'
                  : 'linear-gradient(135deg, #7c3aed, #8b5cf6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 8px rgba(124, 58, 237, 0.25)',
              }}>
                {m.role === 'user' ? <Sparkles size={14} color="#fff" /> : <Bot size={14} color="#fff" />}
              </div>
              {/* Bubble + verdict */}
              <div style={{ minWidth: 0 }}>
                <div style={{
                  padding: '12px 16px', fontSize: '14px', lineHeight: '1.7',
                  borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: m.role === 'user'
                    ? 'linear-gradient(135deg, #7c3aed, #6d28d9)'
                    : 'var(--surface2)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                  boxShadow: m.role === 'user'
                    ? '0 4px 16px rgba(124, 58, 237, 0.15)'
                    : 'var(--shadow-sm)',
                  position: 'relative',
                }}>
                  {m.role === 'assistant' ? (
                    <div className="markdown"><ReactMarkdown>{m.content}</ReactMarkdown></div>
                  ) : m.content}

                  {m.verdict && m.verdict !== 'pass' && m.role === 'assistant' && (
                    <div style={{
                      position: 'absolute', top: '8px', right: '8px',
                      color: verdictColor(m.verdict), opacity: 0.6,
                    }}>
                      <Shield size={14} />
                    </div>
                  )}
                </div>
                {m.verdict && (
                  <div style={{
                    display: 'flex', gap: '5px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center',
                    paddingLeft: '4px',
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
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: 'linear-gradient(135deg, #7c3aed, #8b5cf6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 8px rgba(124, 58, 237, 0.25)',
              }}>
                <Bot size={14} color="#fff" />
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
      </div>

      {/* Input area */}
      <div style={{
        padding: '16px 24px 24px', borderTop: '1px solid var(--border)',
        background: 'rgba(15, 20, 35, 0.5)',
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', gap: '10px' }}>
          <div style={{
            flex: 1, position: 'relative',
            borderRadius: 'var(--radius-sm)',
            boxShadow: inputFocused ? '0 0 0 2px rgba(124, 58, 237, 0.2), 0 0 16px rgba(124, 58, 237, 0.1)' : 'none',
            transition: 'box-shadow 0.25s ease',
          }}>
            <input
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="Ask your assistant anything..."
              style={{ ...S.input, width: '100%', fontSize: '14px', padding: '12px 16px' }}
            />
          </div>
          <button onClick={send} disabled={sending || !input.trim()} style={{
            ...S.btnPrimary,
            opacity: sending || !input.trim() ? 0.4 : 1,
            padding: '12px 18px',
          }}><Send size={16} /></button>
        </div>
        <div style={{
          maxWidth: '800px', margin: '8px auto 0', textAlign: 'center',
          fontSize: '11px', color: 'var(--text-muted)',
        }}>
          All messages pass through security guardrails. Your credentials are held by Auth0 Token Vault -- never exposed.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected Services Screen
// ---------------------------------------------------------------------------

function ServicesScreen() {
  const [connectedServices, setConnectedServices] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [hoveredService, setHoveredService] = useState<string | null>(null);

  // Check connected state from consent API
  const fetchConnections = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/consent/connections`);
      if (r.ok) {
        const d = await r.json();
        const connected = new Set<string>(
          (d.connections || []).filter((c: any) => c.status === 'connected').map((c: any) => c.service_id)
        );
        setConnectedServices(connected);
      }
    } catch { /* noop */ }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  const handleConnect = async (serviceId: string) => {
    setConnecting(serviceId);
    try {
      const r = await authFetch(`${API}/api/consent/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceId }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.authorization_url) {
          // In production, redirect to Auth0 consent screen
          // For demo mode, mark as connected
          window.open(d.authorization_url, '_blank');
        }
        // Refresh connections
        setTimeout(fetchConnections, 1000);
      }
    } catch { /* noop */ }
    setConnecting(null);
  };

  const handleDisconnect = async (serviceId: string) => {
    try {
      await authFetch(`${API}/api/consent/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceId }),
      });
      fetchConnections();
    } catch { /* noop */ }
  };

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflow: 'auto', padding: '32px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>Connected Services</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.7' }}>
            Connect your accounts so your AI assistant can act on your behalf. Credentials are held securely
            in Auth0 Token Vault -- they never touch this device. You can revoke access at any time.
          </p>
        </div>

        {/* Token Vault info banner */}
        <div style={{
          ...S.card, padding: '16px 20px', marginBottom: '24px',
          background: 'rgba(124, 58, 237, 0.06)',
          border: '1px solid rgba(124, 58, 237, 0.2)',
          display: 'flex', alignItems: 'center', gap: '14px',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '10px', flexShrink: 0,
            background: 'rgba(124, 58, 237, 0.15)', border: '1px solid rgba(124, 58, 237, 0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Lock size={16} style={{ color: '#a78bfa' }} />
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
            <strong style={{ color: '#c4b5fd' }}>Auth0 Token Vault</strong> holds all third-party tokens.
            This app never sees raw credentials. Tokens are exchanged per-request and automatically expire.
          </div>
        </div>

        {/* Service cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {SERVICES.map(service => {
            const isConnected = connectedServices.has(service.id);
            const isConnecting = connecting === service.id;
            const isHovered = hoveredService === service.id;

            return (
              <div
                key={service.id}
                onMouseEnter={() => setHoveredService(service.id)}
                onMouseLeave={() => setHoveredService(null)}
                style={{
                  ...S.card, padding: '20px 24px',
                  display: 'flex', alignItems: 'center', gap: '16px',
                  border: isConnected
                    ? '1px solid rgba(34, 197, 94, 0.2)'
                    : isHovered ? '1px solid rgba(124, 58, 237, 0.3)' : '1px solid var(--border)',
                  boxShadow: isHovered ? 'var(--shadow)' : 'var(--shadow-sm)',
                  transition: 'all 0.2s ease',
                }}
              >
                {/* Icon */}
                <div style={{
                  width: 48, height: 48, borderRadius: '14px', flexShrink: 0,
                  background: isConnected ? `${service.color}18` : 'var(--surface2)',
                  color: isConnected ? service.color : 'var(--text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${isConnected ? `${service.color}30` : 'var(--border-light)'}`,
                  transition: 'all 0.2s ease',
                }}>
                  {service.icon}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                    <span style={{ fontWeight: 600, fontSize: '15px' }}>{service.name}</span>
                    {isConnected && (
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%', background: 'var(--pass)',
                        animation: 'livePulse 2s infinite',
                      }} />
                    )}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                    {service.description}
                  </div>
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {service.scopes.map(scope => (
                      <span key={scope} style={{
                        fontSize: '10px', padding: '2px 7px', borderRadius: '5px',
                        background: 'var(--surface2)', color: 'var(--text-muted)',
                        border: '1px solid var(--border-light)',
                        fontFamily: 'monospace',
                      }}>{scope}</span>
                    ))}
                  </div>
                </div>

                {/* Action button */}
                {isConnected ? (
                  <button onClick={() => handleDisconnect(service.id)} style={{
                    ...S.btnGhost, padding: '8px 16px', fontSize: '12px',
                    color: 'var(--text-muted)',
                    display: 'flex', alignItems: 'center', gap: '6px',
                  }}>
                    <Unlink size={13} /> Disconnect
                  </button>
                ) : (
                  <button onClick={() => handleConnect(service.id)} disabled={isConnecting} style={{
                    ...S.btnPrimary, padding: '8px 18px', fontSize: '13px',
                    opacity: isConnecting ? 0.5 : 1,
                  }}>
                    {isConnecting ? (
                      <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Connecting...</>
                    ) : (
                      <><Link2 size={14} /> Connect</>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Safety Screen (Dead-Man Switch)
// ---------------------------------------------------------------------------

function SafetyScreen({ instanceId }: { instanceId: string }) {
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [vault, setVault] = useState<VaultConnection[]>([]);
  const [checkinWord, setCheckinWord] = useState('alive');
  const [checkinResult, setCheckinResult] = useState<{ accepted: boolean; message: string } | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [simulateLoading, setSimulateLoading] = useState(false);
  const [countdown, setCountdown] = useState('');

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
      case 'armed': return 'ARMED';
      case 'grace': return 'GRACE PERIOD';
      case 'triggered': return 'TRIGGERED';
      case 'completed': return 'COMPLETED';
      case 'disarmed': return 'DISARMED';
      default: return 'NOT CONFIGURED';
    }
  };

  const isTriggered = status?.state === 'triggered' || status?.state === 'completed';

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflow: 'auto', padding: '32px' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
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
                <Shield size={18} color="#fff" />
              </div>
              <h1 style={{ fontSize: '22px', fontWeight: 700 }}>Safety Settings</h1>
            </div>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '600px', lineHeight: '1.7' }}>
              Configure the Dead-Man Switch. If you miss a check-in, your data is automatically encrypted, distributed
              to trusted contacts, and credentials are revoked. You cannot surrender credentials you do not have.
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
              {simulateLoading ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
              Simulate Trigger
            </button>
          </div>
        </div>

        {/* Setup form */}
        {showSetup && (
          <div style={{ ...S.card, padding: '24px', animation: 'fadeIn 0.2s ease-out', border: '1px solid rgba(124,58,237,0.3)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={15} style={{ color: '#a78bfa' }} /> Configure Dead-Man Switch
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
          {/* State card */}
          <div style={{
            ...S.card, padding: '24px',
            border: `1px solid ${status?.configured ? stateColor(status.state) + '44' : 'var(--border)'}`,
            boxShadow: status?.configured ? `0 0 24px ${stateColor(status?.state || '')}18` : 'var(--shadow-sm)',
            position: 'relative', overflow: 'hidden',
          }}>
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
                marginBottom: '16px', fontFamily: 'monospace',
              }}>
                {status?.configured ? stateLabel(status.state) : 'NOT CONFIGURED'}
              </div>

              {status?.configured && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {[
                      { label: 'Next check-in', value: countdown || '--', highlight: status.overdue_by_seconds > 0 },
                      { label: 'Total check-ins', value: String(status.checkins_total), highlight: false },
                      { label: 'Contacts', value: String(status.trusted_contacts), highlight: false },
                      { label: 'Destinations', value: String(status.secure_destinations), highlight: false },
                    ].map(item => (
                      <div key={item.label} style={{
                        background: 'var(--surface2)', border: '1px solid var(--border)',
                        borderRadius: '8px', padding: '10px 14px', flex: '1 1 100px',
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
                          {Math.floor(status.grace_remaining_seconds / 60)} minutes remaining.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!status?.configured && (
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                  Click Configure above to set your check-in schedule, trusted contacts, and secure destinations.
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

        {/* Token Vault connections */}
        <div style={{ ...S.card, padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Auth0 Token Vault Connections
            </div>
            <div style={{
              fontSize: '10px', background: 'rgba(124,58,237,0.15)', color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.3)', borderRadius: '10px', padding: '2px 8px', fontWeight: 600,
            }}>
              {vault.length} active
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
            </div>
          )}
        </div>

        {/* Protocol log */}
        {status?.distribution_log && status.distribution_log.length > 0 && (
          <div style={{ ...S.card, padding: '24px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>
              Protocol Log
            </div>
            <div style={{
              background: '#0a0c14', border: '1px solid var(--border)',
              borderRadius: '8px', padding: '14px', fontFamily: 'monospace',
              fontSize: '11px', lineHeight: '1.8', color: '#a0aec0',
              maxHeight: '280px', overflow: 'auto',
            }}>
              {status.distribution_log.map((line, i) => (
                <div key={i} style={{
                  color: line.includes('ERROR') ? '#f87171'
                    : line.includes('COMPLETE') ? '#4ade80'
                    : line.includes('WARNING') ? '#fbbf24'
                    : line.includes('TRIGGERED') ? '#f87171'
                    : '#a0aec0',
                }}>{line}</div>
              ))}
            </div>
          </div>
        )}

        {/* Explanation */}
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
              How it works
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.7', maxWidth: '800px' }}>
              Auth0 Token Vault holds all third-party credentials. When the Dead-Man Switch fires,
              it exchanges your Auth0 token for scoped API tokens (e.g. Google Drive write-once, 60 minutes).
              Data is encrypted and distributed to your trusted contacts. All tokens are then revoked.
              <strong style={{ color: '#a78bfa' }}> You cannot surrender credentials you do not have.</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Screen (Audit Log)
// ---------------------------------------------------------------------------

function ActivityScreen() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

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

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflow: 'auto', padding: '32px' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
          <Activity size={20} style={{ color: 'var(--accent)' }} />
          <h1 style={{ fontSize: '22px', fontWeight: 700 }}>Activity Log</h1>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', background: 'var(--pass)',
            animation: 'livePulse 2s infinite', marginLeft: '4px',
          }} />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Real-time audit trail</span>
        </div>

        {/* Stats */}
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
                <div style={{ fontSize: '28px', fontWeight: 700, lineHeight: '1', color: 'var(--text)' }}>{s.value}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500, marginTop: '2px' }}>{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Event list */}
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
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>No activity yet</div>
            <div style={{ fontSize: '13px' }}>Events will appear here in real-time as the guardrails process messages</div>
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
                    display: 'flex',
                  }}
                >
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
                      {ev.model_used && (
                        <span style={{
                          fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                          background: 'rgba(124, 58, 237, 0.1)', color: '#6d28d9',
                          border: '1px solid rgba(124, 58, 237, 0.15)',
                          fontWeight: 500,
                        }}>
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
  );
}

// ---------------------------------------------------------------------------
// Permissions Screen
// ---------------------------------------------------------------------------

function PermissionsScreen() {
  const [connectedServices, setConnectedServices] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Fetch connected services
    authFetch(`${API}/api/consent/connections`).then(r => r.json()).then(d => {
      const connected = new Set<string>(
        (d.connections || []).filter((c: any) => c.status === 'connected').map((c: any) => c.service_id)
      );
      setConnectedServices(connected);
    }).catch(() => { /* noop */ });
  }, []);

  const handleRevoke = async (serviceId: string) => {
    try {
      await authFetch(`${API}/api/consent/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceId }),
      });
      setConnectedServices(prev => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
    } catch { /* noop */ }
  };

  const connectedServiceList = SERVICES.filter(s => connectedServices.has(s.id));
  const disconnectedServiceList = SERVICES.filter(s => !connectedServices.has(s.id));

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflow: 'auto', padding: '32px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <KeyRound size={20} style={{ color: 'var(--accent)' }} />
            <h1 style={{ fontSize: '22px', fontWeight: 700 }}>Permissions</h1>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.7' }}>
            Review and manage what your AI assistant can access. Revoke any service at any time.
            All credentials are held by Auth0 Token Vault, not on this device.
          </p>
        </div>

        {/* Active permissions */}
        {connectedServiceList.length > 0 && (
          <div style={{ marginBottom: '32px' }}>
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>
              Active Permissions
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {connectedServiceList.map(service => (
                <div key={service.id} style={{
                  ...S.card, padding: '16px 20px',
                  display: 'flex', alignItems: 'center', gap: '14px',
                  border: '1px solid rgba(34, 197, 94, 0.15)',
                }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '12px',
                    background: `${service.color}18`, color: service.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${service.color}30`,
                  }}>{service.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{service.name}</span>
                      <ToggleRight size={18} style={{ color: 'var(--pass)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                      {service.scopes.map(scope => (
                        <span key={scope} style={{
                          fontSize: '10px', padding: '2px 7px', borderRadius: '5px',
                          background: 'var(--surface2)', color: 'var(--text-muted)',
                          border: '1px solid var(--border-light)', fontFamily: 'monospace',
                        }}>{scope}</span>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => handleRevoke(service.id)} style={{
                    ...S.btnGhost, fontSize: '12px', padding: '6px 14px',
                    color: 'var(--block)', borderColor: 'rgba(239, 68, 68, 0.3)',
                    background: 'var(--block-light)',
                  }}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Inactive permissions */}
        {disconnectedServiceList.length > 0 && (
          <div style={{ marginBottom: '32px' }}>
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>
              Not Connected
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {disconnectedServiceList.map(service => (
                <div key={service.id} style={{
                  ...S.card, padding: '16px 20px',
                  display: 'flex', alignItems: 'center', gap: '14px',
                  opacity: 0.6,
                }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '12px',
                    background: 'var(--surface2)', color: 'var(--text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px solid var(--border-light)',
                  }}>{service.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{service.name}</span>
                      <ToggleLeft size={18} style={{ color: 'var(--text-muted)' }} />
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {service.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token Vault info */}
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
            <Eye size={16} style={{ color: '#a78bfa' }} />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#c4b5fd', marginBottom: '4px' }}>
              Credential Transparency
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.7' }}>
              All OAuth tokens are stored in Auth0 Token Vault. This application never has direct access
              to your passwords or long-lived tokens. Access is granted per-request through token exchange,
              with automatic expiration. You can revoke any permission instantly.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
      backgroundImage: 'radial-gradient(circle at 50% 40%, rgba(124, 58, 237, 0.08), transparent 60%)',
    }}>
      <form onSubmit={handleSubmit} style={{
        ...S.glass,
        padding: '48px 40px', minWidth: '380px', maxWidth: '420px',
        display: 'flex', flexDirection: 'column', gap: '24px',
        animation: 'fadeIn 0.5s ease-out',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '16px',
            background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '18px', fontWeight: 800, color: '#fff', marginBottom: '16px',
            letterSpacing: '-0.5px',
            boxShadow: '0 0 24px rgba(124, 58, 237, 0.4)',
          }}>AX</div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '24px', fontWeight: 700 }}>AssistantX</h2>
          <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.6' }}>
            Your secure AI assistant. Credentials stay in Token Vault.
          </p>
        </div>
        <div>
          <label style={S.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter password"
            autoFocus
            style={{ ...S.input, fontSize: '14px', padding: '12px 16px' }}
          />
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: '13px', textAlign: 'center' }}>{error}</div>}
        <button
          type="submit"
          disabled={loading || !password}
          style={{
            ...S.btnPrimary,
            width: '100%', justifyContent: 'center',
            padding: '12px 0', fontSize: '14px',
            opacity: loading || !password ? 0.5 : 1,
          }}
        >
          {loading ? (
            <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Signing in...</>
          ) : 'Sign In'}
        </button>
        <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
          Protected by Auth0 Token Vault
        </div>
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

  return <AuthedApp onLogout={() => {
    sessionStorage.removeItem('assistantx_token');
    setAuthed(false);
  }} />;
}

function AuthedApp({ onLogout }: { onLogout: () => void }) {
  const [screen, setScreen] = useState<Screen>('chat');
  const [instances, setInstances] = useState<Instance[]>([]);
  const [defaultInstanceId, setDefaultInstanceId] = useState<string | null>(null);

  // Fetch instances (we use the first one as the default)
  const fetchInstances = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/api/instances`);
      const d = await r.json();
      const list = Array.isArray(d) ? d : [];
      setInstances(list);
      if (list.length > 0 && !defaultInstanceId) {
        setDefaultInstanceId(list[0].id);
      }
    } catch { /* noop */ }
  }, [defaultInstanceId]);

  useEffect(() => {
    fetchInstances();
    const iv = setInterval(fetchInstances, 8000);
    return () => clearInterval(iv);
  }, [fetchInstances]);

  const isConnected = instances.some(i => i.status === 'running');
  const instanceId = defaultInstanceId || instances[0]?.id || 'demo';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <NavBar
        screen={screen}
        setScreen={setScreen}
        isConnected={isConnected}
        onLogout={onLogout}
      />
      {screen === 'chat' && <ChatScreen instanceId={instanceId} />}
      {screen === 'services' && <ServicesScreen />}
      {screen === 'safety' && <SafetyScreen instanceId={instanceId} />}
      {screen === 'activity' && <ActivityScreen />}
      {screen === 'permissions' && <PermissionsScreen />}
    </div>
  );
}
