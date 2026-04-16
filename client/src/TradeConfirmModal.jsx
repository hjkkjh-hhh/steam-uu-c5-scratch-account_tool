import { useState, useCallback, useEffect } from 'react';
import api from './api';

// ── 平台样式 ──────────────────────────────────────────────────────────────────
const PLATFORM_COLORS = {
  'BUFF':     { icon: '🟠', color: '#f97316' },
  '悠悠有品': { icon: '🟣', color: '#a855f7' },
  'C5Game':   { icon: '🔵', color: '#38bdf8' },
  '库存转移': { icon: '📦', color: '#22c55e' },
  '交易市场': { icon: '🏪', color: '#f59e0b' },
  '普通用户': { icon: '👤', color: '#94a3b8' },
};
function getPlatformStyle(source) {
  if (!source) return PLATFORM_COLORS['普通用户'];
  return PLATFORM_COLORS[source.name] || { icon: source.icon || '👤', color: source.color || '#94a3b8' };
}

// ── 时间格式化（兼容 unix 秒、ISO string）────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '';
  let d;
  if (typeof ts === 'string') {
    d = new Date(ts);       // ISO string
  } else {
    d = new Date(ts > 1e10 ? ts : ts * 1000); // unix 秒或毫秒
  }
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export default function TradeConfirmModal({ onClose, accounts = [], groups = [] }) {
  const [filterGroupId, setFilterGroupId] = useState('all');
  const [loading, setLoading] = useState(false);
  const [accountData, setAccountData] = useState([]);
  const [selected, setSelected] = useState(new Set());   // Set of "accountId::confId"
  const [expanded, setExpanded] = useState(new Set());   // Set of "accountId::confId" (展开详情)
  const [confirming, setConfirming] = useState(false);
  const [confirmResults, setConfirmResults] = useState([]);
  const [fromCache, setFromCache] = useState(false);
  const [acceptingFor, setAcceptingFor] = useState(null); // accountId being accepted
  const [acceptResult, setAcceptResult] = useState(null);

  // ── 按分组过滤账号 ────────────────────────────────────────────────────────
  const filteredAccounts = filterGroupId === 'all'
    ? accounts
    : filterGroupId === '__ungrouped'
    ? accounts.filter(a => !a.groupId)
    : accounts.filter(a => String(a.groupId) === String(filterGroupId));

  // ── 打开时自动尝试读缓存 ──────────────────────────────────────────────────
  useEffect(() => {
    const tryCache = async () => {
      try {
        const ids = accounts.map(a => String(a.id));
        const resp = await api.post('accounts/get-confirmations', { accountIds: ids, useCache: true });
        if (resp.data.results?.length > 0) {
          setAccountData(resp.data.results);
          setFromCache(true);
        }
      } catch (_) {}
    };
    tryCache();
  }, []);

  // ── 刷新（强制拉取）──────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    setAccountData([]);
    setSelected(new Set());
    setExpanded(new Set());
    setConfirmResults([]);
    setFromCache(false);
    try {
      const ids = filteredAccounts.map(a => String(a.id));
      const resp = await api.post('accounts/get-confirmations', { accountIds: ids });
      setAccountData(resp.data.results || []);
    } catch (e) {
      console.error('[令牌确认] 加载失败:', e.message);
    } finally {
      setLoading(false);
    }
  }, [filteredAccounts]);

  // ── 选择控制 ──────────────────────────────────────────────────────────────
  const key = (accountId, confId) => `${accountId}::${confId}`;

  const toggle = (accountId, confId) => {
    const k = key(accountId, confId);
    setSelected(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  };

  const toggleExpand = (accountId, confId) => {
    const k = key(accountId, confId);
    setExpanded(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  };

  const toggleAccount = (accountId, confs) => {
    const keys = confs.map(c => key(accountId, c.id));
    const allSel = keys.every(k => selected.has(k));
    setSelected(prev => {
      const n = new Set(prev);
      if (allSel) keys.forEach(k => n.delete(k));
      else keys.forEach(k => n.add(k));
      return n;
    });
  };

  const selectAll = () => {
    const all = new Set();
    accountData.forEach(ad => ad.confirmations.forEach(c => all.add(key(ad.accountId, c.id))));
    setSelected(all);
  };
  const clearAll = () => setSelected(new Set());

  const totalConfs = accountData.reduce((s, ad) => s + (ad.confirmations?.length || 0), 0);

  // ── 构建 payload 并发送确认/拒绝 ─────────────────────────────────────────
  const buildPayload = (action) => {
    const payload = [];
    for (const k of selected) {
      const [accountId, confirmationId] = k.split('::');
      const ad = accountData.find(a => String(a.accountId) === String(accountId));
      const conf = ad?.confirmations.find(c => String(c.id) === String(confirmationId));
      if (conf) payload.push({ accountId, confirmationId: conf.id, confirmationKey: conf.key, action });
    }
    return payload;
  };

  // ── 操作成功后：只删除已处理的条目，不重新拉取 ──────────────────────
  const removeSucceeded = (results) => {
    // 收集操作成功的 confirmationId 集合
    const doneKeys = new Set(
      results.filter(r => r.success).map(r => `${r.accountId}::${r.confirmationId}`)
    );
    if (doneKeys.size === 0) return;
    // 从本地 state 删除已处理的连接
    setAccountData(prev => prev.map(ad => ({
      ...ad,
      confirmations: ad.confirmations.filter(
        c => !doneKeys.has(`${ad.accountId}::${c.id}`)
      )
    })).filter(ad => ad.confirmations.length > 0 || ad.error));
    // 从已选集合中移除
    setSelected(prev => {
      const n = new Set(prev);
      doneKeys.forEach(k => n.delete(k));
      return n;
    });
  };

  // 单条快捷操作
  const quickAction = async (accountId, conf, action) => {
    setConfirming(true);
    setConfirmResults([]);
    try {
      const resp = await api.post('accounts/confirm-trades', {
        confirmations: [{ accountId, confirmationId: conf.id, confirmationKey: conf.key, action }]
      });
      const results = resp.data.results || [];
      setConfirmResults(results);
      removeSucceeded(results);
    } catch (e) {
      console.error('[令牌确认] 操作失败:', e.message);
    } finally {
      setConfirming(false);
    }
  };

  // 批量确认
  const confirmSelected = async () => {
    const payload = buildPayload('allow');
    if (!payload.length) return;
    setConfirming(true);
    setConfirmResults([]);
    try {
      const resp = await api.post('accounts/confirm-trades', { confirmations: payload });
      const results = resp.data.results || [];
      setConfirmResults(results);
      removeSucceeded(results);
    } catch (e) {
      console.error('[令牌确认] 确认失败:', e.message);
    } finally {
      setConfirming(false);
    }
  };

  // 批量拒绝
  const denySelected = async () => {
    const payload = buildPayload('deny');
    if (!payload.length) return;
    setConfirming(true);
    setConfirmResults([]);
    try {
      const resp = await api.post('accounts/confirm-trades', { confirmations: payload });
      const results = resp.data.results || [];
      setConfirmResults(results);
      removeSucceeded(results);
    } catch (e) {
      console.error('[令牌确认] 拒绝失败:', e.message);
    } finally {
      setConfirming(false);
    }
  };

  // ► 指定账号自动接受传入报价 + 令牌确认
  const acceptIncomingOffers = async (accountId, accountName) => {
    if (!window.confirm(`将对「${accountName}」执行：\n1. 批量接受所有传入报价\n2. 自动令牌确认接受\n确认继续？`)) return;
    setAcceptingFor(String(accountId));
    setAcceptResult(null);
    try {
      const resp = await api.post('accounts/accept-incoming-offers', { accountId });
      const d = resp.data;
      setAcceptResult({ accountName, ...d });
      if (d.totalFound === 0) {
        window.alert(`ℹ️ ${accountName} 没有找到待接受的传入报价。\n可能是之前的报价还处于待发出方令牌确认状态，\n请先到各A账号的令牌确认面板确认发出。`);
      } else {
        window.alert(`✅ ${accountName} 处理完成!\n找到 ${d.totalFound} 个传入报价\n成功接受 ${d.accepted} 个\n令牌确认 ${d.totp_confirmed} 个`);
        setTimeout(() => refresh(), 2000);
      }
    } catch (e) {
      window.alert('❌ 失败: ' + (e.response?.data?.error || e.message));
    } finally {
      setAcceptingFor(null);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>

        {/* 标题栏 */}
        <div style={S.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.4rem' }}>🔑</span>
            <div>
              <h3 style={S.title}>令牌确认</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                TOTP 批量确认 / 拒绝待处理交易报价
                {fromCache && <span style={{ marginLeft: '0.5rem', color: '#22c55e', fontSize: '0.7rem' }}>⚡ 缓存数据</span>}
              </div>
            </div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* 筛选栏 */}
        <div style={S.toolbar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>分组：</span>
            <select style={S.select} value={filterGroupId} onChange={e => setFilterGroupId(e.target.value)}>
              <option value="all" style={{ background: '#1e293b', color: '#fff' }}>全部账号 ({accounts.length})</option>
              {groups.map(g => (
                <option key={g.id} value={g.id} style={{ background: '#1e293b', color: '#fff' }}>
                  {g.name} ({accounts.filter(a => String(a.groupId) === String(g.id)).length})
                </option>
              ))}
              <option value="__ungrouped" style={{ background: '#1e293b', color: '#fff' }}>未分组 ({accounts.filter(a => !a.groupId).length})</option>
            </select>
            <button style={S.refreshBtn} onClick={refresh} disabled={loading}>
              {loading ? '加载中...' : '🔄 刷新'}
            </button>
            {/* 接受传入报价：对指定账号 */}
            <select
              style={{ ...S.select, color: '#22c55e', borderColor: 'rgba(34,197,94,0.35)' }}
              onChange={e => {
                const accId = e.target.value;
                const accName = accounts.find(a => String(a.id) === accId)?.name || accId;
                if (accId) acceptIncomingOffers(accId, accName);
                e.target.value = '';
              }}
              defaultValue=""
            >
              <option value="" disabled>📥 接受传入报价...</option>
              {filteredAccounts.map(a => (
                <option key={a.id} value={String(a.id)} style={{ background: '#1e293b', color: '#fff' }}>
                  {a.name}{acceptingFor === String(a.id) ? ' (处理中...)' : ''}
                </option>
              ))}
            </select>
          </div>
          {totalConfs > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                共 {totalConfs} 条 · 已选 {selected.size}
              </span>
              <button style={S.miniBtn} onClick={selectAll}>全选</button>
              <button style={S.miniBtn} onClick={clearAll}>清空</button>
            </div>
          )}
        </div>

        {/* 内容区 */}
        <div style={S.body}>
          {/* 操作结果提示 */}
          {confirmResults.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              {confirmResults.map((r, i) => (
                <div key={i} style={{ ...S.resultRow, borderColor: r.success ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)', background: r.success ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)' }}>
                  <span>{r.success ? (r.action === 'deny' ? '🚫' : '✅') : '❌'}</span>
                  <span style={{ flex: 1, fontSize: '0.83rem' }}>
                    {r.accountName} · #{r.confirmationId}
                    {r.success && r.action === 'deny' && <span style={{ color: '#f87171', marginLeft: '0.4rem' }}>已拒绝</span>}
                  </span>
                  {!r.success && <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{r.error}</span>}
                </div>
              ))}
            </div>
          )}

          {loading && (
            <div style={{ textAlign: 'center', color: 'var(--accent-color)', padding: '3rem', fontSize: '0.9rem' }}>
              ⏳ 正在查询待确认交易...
            </div>
          )}

          {!loading && accountData.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
              {totalConfs === 0 && confirmResults.length === 0
                ? '点击「🔄 刷新」按钮加载待确认交易'
                : '🎉 暂无待确认交易'}
            </div>
          )}

          {/* 按账号分组展示 */}
          {accountData.map(ad => {
            if (ad.confirmations.length === 0) return null;
            const allSel = ad.confirmations.every(c => selected.has(key(ad.accountId, c.id)));
            const someSel = ad.confirmations.some(c => selected.has(key(ad.accountId, c.id)));
            return (
              <div key={ad.accountId} style={S.accountGroup}>
                {/* 账号标题行 */}
                <div style={S.accountHeader}>
                  <input type="checkbox" checked={allSel}
                    ref={el => { if (el) el.indeterminate = !allSel && someSel; }}
                    onChange={() => toggleAccount(ad.accountId, ad.confirmations)}
                    style={{ accentColor: '#38bdf8' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{ad.accountName}</span>
                  <span style={S.countBadge}>{ad.confirmations.length} 条</span>
                  {ad.error && <span style={{ fontSize: '0.72rem', color: '#ef4444' }}>⚠️ {ad.error}</span>}
                </div>

                {/* 紧凑网格卡片 */}
                <div style={S.cardGrid}>
                  {ad.confirmations.map(conf => {
                    const sel = selected.has(key(ad.accountId, conf.id));
                    const isExpanded = expanded.has(key(ad.accountId, conf.id));
                    const src = conf.source || {};
                    const ps = getPlatformStyle(src);
                    const isInternal = src.name === '库存转移';
                    const hasSending = conf.sending?.length > 0;
                    const hasReceiving = conf.receiving?.length > 0;

                    return (
                      <div key={conf.id} style={{ ...S.card, ...(sel ? S.cardSel : {}), ...(isInternal ? S.cardInternal : {}) }}>
                        {/* 卡片头部：checkbox + 平台 + 时间 */}
                        <div style={S.cardTop}>
                          <input type="checkbox" checked={sel} onChange={() => toggle(ad.accountId, conf.id)}
                            onClick={e => e.stopPropagation()}
                            style={{ accentColor: '#38bdf8', flexShrink: 0 }} />
                          <span style={{ ...S.platformTag, borderColor: ps.color + '60', color: ps.color, background: ps.color + '18' }}>
                            {ps.icon} {src.name || '普通用户'}
                          </span>
                          {src.matchedAccount && (
                            <span style={S.matchedBadge}>→ {src.matchedAccount}</span>
                          )}
                          <span style={{ flex: 1 }} />
                          <span style={S.timeTag}>{fmtTime(conf.time)}</span>
                        </div>

                        {/* 标题行，点击展开/收起 */}
                        <div style={S.cardTitleRow} onClick={() => toggleExpand(ad.accountId, conf.id)}>
                          <span style={S.cardTitle}>{conf.title}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                            {isExpanded ? '▲' : '▼'}
                          </span>
                        </div>

                        {/* 物品摘要（收起时显示） */}
                        {!isExpanded && (hasSending || hasReceiving) && (
                          <div style={S.cardItems}>
                            {hasSending && (
                              <span style={S.itemChipOut}>
                                ↑ {conf.sending.slice(0, 2).join(' / ')}{conf.sending.length > 2 ? ` +${conf.sending.length - 2}` : ''}
                              </span>
                            )}
                            {hasReceiving && (
                              <span style={S.itemChipIn}>
                                ↓ {conf.receiving.slice(0, 2).join(' / ')}{conf.receiving.length > 2 ? ` +${conf.receiving.length - 2}` : ''}
                              </span>
                            )}
                          </div>
                        )}

                        {/* 展开詳情 */}
                        {isExpanded && (
                          <div style={S.detailBox}>
                            {hasSending && (
                              <div style={S.detailSection}>
                                <div style={{ ...S.detailLabel, color: '#f87171' }}>↑ 送出 ({conf.sending.length})</div>
                                <div style={S.detailItems}>
                                  {conf.sending.map((item, i) => (
                                    <div key={i} style={S.detailItem}>{item}</div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {hasReceiving && (
                              <div style={S.detailSection}>
                                <div style={{ ...S.detailLabel, color: '#4ade80' }}>↓ 收入 ({conf.receiving.length})</div>
                                <div style={S.detailItems}>
                                  {conf.receiving.map((item, i) => (
                                    <div key={i} style={S.detailItem}>{item}</div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {!hasSending && !hasReceiving && (
                              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>暂无物品详情</div>
                            )}
                          </div>
                        )}

                        {/* 快捷操作按钮 */}
                        <div style={S.cardActions}>
                          <button style={S.quickConfirmBtn} disabled={confirming}
                            onClick={e => { e.stopPropagation(); quickAction(ad.accountId, conf, 'allow'); }}>
                            ✅ 确认
                          </button>
                          <button style={S.quickDenyBtn} disabled={confirming}
                            onClick={e => { e.stopPropagation(); quickAction(ad.accountId, conf, 'deny'); }}>
                            ❌ 拒绝
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部操作栏 */}
        <div style={S.footer}>
          <div style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>
            {selected.size > 0 ? `已选 ${selected.size} 条` : '请在上方选择要操作的交易'}
          </div>
          <div style={{ flex: 1 }} />
          <button style={S.btnSecondary} onClick={onClose}>取消</button>
          <button
            style={{ ...S.btnDeny, ...(selected.size === 0 || confirming ? S.btnDisabled : {}) }}
            disabled={selected.size === 0 || confirming}
            onClick={denySelected}>
            {confirming ? '⏳...' : `❌ 拒绝所选 (${selected.size})`}
          </button>
          <button
            style={{ ...S.btnPrimary, ...(selected.size === 0 || confirming ? S.btnDisabled : {}) }}
            disabled={selected.size === 0 || confirming}
            onClick={confirmSelected}>
            {confirming ? '⏳ 处理中...' : `✅ 确认所选 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 样式 ──────────────────────────────────────────────────────────────────────
const S = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(4px)', zIndex: 99999,
    display: 'flex', alignItems: 'center', justifyContent: 'center'
  },
  modal: {
    width: '92vw', maxWidth: '900px', height: '84vh',
    background: 'var(--card-bg, #1e293b)',
    border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
    borderRadius: '1rem', display: 'flex', flexDirection: 'column',
    overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)'
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.1rem 1.5rem 0.9rem', borderBottom: '1px solid var(--glass-border)', flexShrink: 0
  },
  title: { margin: 0, fontSize: '1.1rem', fontWeight: 700 },
  closeBtn: { background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '1.5rem', cursor: 'pointer' },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.6rem 1.5rem', borderBottom: '1px solid var(--glass-border)',
    gap: '0.75rem', flexShrink: 0, flexWrap: 'wrap'
  },
  select: {
    padding: '0.35rem 0.6rem', borderRadius: '6px', fontSize: '0.83rem',
    background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)',
    color: 'var(--text-main)', cursor: 'pointer', outline: 'none'
  },
  refreshBtn: {
    padding: '0.35rem 0.8rem', borderRadius: '6px', fontSize: '0.83rem',
    background: 'rgba(56,189,248,0.12)', color: '#38bdf8',
    border: '1px solid rgba(56,189,248,0.3)', cursor: 'pointer', fontWeight: 500
  },
  miniBtn: {
    padding: '0.25rem 0.6rem', borderRadius: '5px', fontSize: '0.75rem',
    background: 'rgba(255,255,255,0.07)', color: 'var(--text-muted)',
    border: '1px solid var(--glass-border)', cursor: 'pointer'
  },
  body: { flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem' },
  accountGroup: { marginBottom: '0.85rem', borderRadius: '0.75rem', border: '1px solid var(--glass-border)', overflow: 'hidden' },
  accountHeader: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.55rem 0.85rem', background: 'rgba(255,255,255,0.04)'
  },
  countBadge: {
    fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: '10px',
    background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 600
  },
  // 卡片网格：2~3列
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '0',
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: '0.28rem',
    padding: '0.55rem 0.85rem 0.5rem',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    borderRight: '1px solid rgba(255,255,255,0.04)',
    transition: 'background 0.15s',
  },
  cardSel: { background: 'rgba(56,189,248,0.08)' },
  cardInternal: { background: 'rgba(34,197,94,0.04)' },
  cardTop: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  cardTitleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '0.4rem', cursor: 'pointer', paddingLeft: '1.3rem',
    userSelect: 'none',
  },
  cardTitle: {
    fontSize: '0.78rem', fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1
  },
  cardItems: { display: 'flex', gap: '0.3rem', flexWrap: 'wrap', paddingLeft: '1.3rem' },
  platformTag: {
    fontSize: '0.68rem', padding: '0.1rem 0.4rem', borderRadius: '4px',
    border: '1px solid', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0
  },
  matchedBadge: {
    fontSize: '0.67rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
    background: 'rgba(34,197,94,0.15)', color: '#22c55e', fontWeight: 600, whiteSpace: 'nowrap'
  },
  timeTag: { fontSize: '0.67rem', color: 'var(--text-muted)', flexShrink: 0 },
  itemChipOut: {
    fontSize: '0.67rem', padding: '0.08rem 0.4rem', borderRadius: '4px',
    background: 'rgba(239,68,68,0.12)', color: '#f87171',
    maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  itemChipIn: {
    fontSize: '0.67rem', padding: '0.08rem 0.4rem', borderRadius: '4px',
    background: 'rgba(34,197,94,0.12)', color: '#4ade80',
    maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  // 展开详情框
  detailBox: {
    marginLeft: '1.3rem', marginTop: '0.2rem',
    padding: '0.5rem 0.6rem',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.06)',
    display: 'flex', flexDirection: 'column', gap: '0.4rem'
  },
  detailSection: { display: 'flex', flexDirection: 'column', gap: '0.18rem' },
  detailLabel: { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.02em' },
  detailItems: { display: 'flex', flexDirection: 'column', gap: '0.1rem' },
  detailItem: {
    fontSize: '0.72rem', color: 'var(--text-main)',
    padding: '0.12rem 0.3rem',
    borderRadius: '3px',
    background: 'rgba(255,255,255,0.04)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  // 卡片快捷按钮
  cardActions: {
    display: 'flex', gap: '0.35rem', paddingLeft: '1.3rem', marginTop: '0.2rem'
  },
  quickConfirmBtn: {
    fontSize: '0.68rem', padding: '0.15rem 0.55rem', borderRadius: '5px',
    background: 'rgba(34,197,94,0.12)', color: '#22c55e',
    border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer', fontWeight: 600
  },
  quickDenyBtn: {
    fontSize: '0.68rem', padding: '0.15rem 0.55rem', borderRadius: '5px',
    background: 'rgba(239,68,68,0.1)', color: '#f87171',
    border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer', fontWeight: 600
  },
  resultRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.75rem',
    borderRadius: '6px', border: '1px solid', marginBottom: '0.3rem'
  },
  footer: {
    display: 'flex', alignItems: 'center', gap: '0.6rem',
    padding: '0.85rem 1.5rem', borderTop: '1px solid var(--glass-border)', flexShrink: 0
  },
  btnPrimary: {
    padding: '0.55rem 1.3rem', borderRadius: '8px', fontWeight: 600, fontSize: '0.88rem',
    background: 'var(--accent-color)', color: '#000', border: 'none', cursor: 'pointer'
  },
  btnDeny: {
    padding: '0.55rem 1.1rem', borderRadius: '8px', fontWeight: 600, fontSize: '0.88rem',
    background: 'rgba(239,68,68,0.12)', color: '#f87171',
    border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer'
  },
  btnSecondary: {
    padding: '0.55rem 1.1rem', borderRadius: '8px', fontWeight: 500, fontSize: '0.88rem',
    background: 'rgba(255,255,255,0.07)', color: 'var(--text-main)',
    border: '1px solid var(--glass-border)', cursor: 'pointer'
  },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
};
