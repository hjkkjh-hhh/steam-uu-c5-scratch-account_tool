import { useState, useEffect, useCallback } from 'react';
import api, { getAuthHeaders } from './api';

// ── 饰品图标 URL 构建 ────────────────────────────────────────────────────────
const iconUrl = (icon) =>
  icon ? `https://community.akamai.steamstatic.com/economy/image/${icon}/96fx96f` : '';

// ── 并发控制工具 ──────────────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit, onProgress) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      if (onProgress) onProgress(results.filter(Boolean).length, tasks.length);
    }
  });
  await Promise.all(workers);
  return results;
}

export default function InventoryTransferModal({ onClose, accounts = [], groups = [] }) {
  // ── Step 管理 ────────────────────────────────────────────────────────────────
  const [step, setStep] = useState(1); // 1=选账号, 2=选饰品, 3=转移结果

  // ── Step 1 状态 ──────────────────────────────────────────────────────────────
  const [selectedSources, setSelectedSources] = useState(new Set()); // 来源账号 id
  const [receiverId, setReceiverId] = useState(null);               // 接收账号 id
  const [receiverSearch, setReceiverSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(new Set()); // 展开的分组

  // ── Step 2 状态 ──────────────────────────────────────────────────────────────
  const [loadedItems, setLoadedItems] = useState([]);               // 所有可交易饰品
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 });
  const [loadingInv, setLoadingInv] = useState(false);
  const [selectedItems, setSelectedItems] = useState(new Set());   // 选中的 assetid
  const [itemSearch, setItemSearch] = useState('');

  // ── Step 3 状态 ──────────────────────────────────────────────────────────────
  const [transferResults, setTransferResults] = useState([]);
  const [transferring, setTransferring] = useState(false);

  // ── 撤销报价状态 ──────────────────────────────────────────────────────────────
  const [cancelling, setCancelling] = useState(false);
  const [cancelResults, setCancelResults] = useState(null); // null = unsent

  // ── 工具：分组后的账号列表 ────────────────────────────────────────────────────
  const groupedAccounts = (() => {
    const result = [];
    const ungrouped = accounts.filter(a => !a.groupId);
    const gMap = {};
    for (const g of groups) gMap[g.id] = { ...g, accounts: [] };
    for (const a of accounts) {
      if (a.groupId && gMap[a.groupId]) gMap[a.groupId].accounts.push(a);
    }
    for (const g of groups) if (gMap[g.id].accounts.length > 0) result.push(gMap[g.id]);
    if (ungrouped.length > 0) result.push({ id: '__ungrouped', name: '未分组', accounts: ungrouped });
    return result;
  })();

  const receiverAccount = accounts.find(a => String(a.id) === String(receiverId));
  const sourceList = accounts.filter(a => selectedSources.has(String(a.id)));

  // ── Step 1: 来源账号多选 ──────────────────────────────────────────────────────
  const toggleSource = (id) => {
    const sid = String(id);
    setSelectedSources(prev => {
      const n = new Set(prev);
      n.has(sid) ? n.delete(sid) : n.add(sid);
      return n;
    });
  };
  const toggleGroupSources = (grpAccounts) => {
    const ids = grpAccounts.map(a => String(a.id));
    const allSelected = ids.every(id => selectedSources.has(id));
    setSelectedSources(prev => {
      const n = new Set(prev);
      if (allSelected) ids.forEach(id => n.delete(id));
      else ids.forEach(id => n.add(id));
      return n;
    });
  };
  const selectAllSources = () => {
    setSelectedSources(new Set(accounts.map(a => String(a.id))));
  };
  const clearAllSources = () => setSelectedSources(new Set());

  const toggleGroupExpand = (groupId) => {
    setExpandedGroups(prev => {
      const n = new Set(prev);
      n.has(groupId) ? n.delete(groupId) : n.add(groupId);
      return n;
    });
  };

  // ── Step 2: 加载库存 ──────────────────────────────────────────────────────────
  const loadInventories = useCallback(async () => {
    const ids = [...selectedSources];
    if (ids.length === 0) return;
    setLoadingInv(true);
    setLoadedItems([]);
    setLoadProgress({ done: 0, total: ids.length });

    try {
      const authHeaders = getAuthHeaders();
      const resp = await fetch('/api/accounts/batch-inventory', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({ accountIds: ids })
      });

      if (!resp.body) throw new Error('ReadableStream not supported');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      
      let currentItems = [];
      let doneCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n\n');
        // last item is either empty or an incomplete chunk
        buffer = lines.pop(); 

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'result') {
                if (data.result && data.result.items) {
                  currentItems = [...currentItems, ...data.result.items];
                  // incrementally show items in UI
                  setLoadedItems([...currentItems]);
                }
                doneCount++;
                setLoadProgress({ done: doneCount, total: ids.length });
              } else if (data.type === 'done') {
                break;
              }
            } catch (err) {
              console.error('SSE chunk parse error', dataStr, err);
            }
          }
        }
      }
    } catch (e) {
      console.error('[库存加载] 失败:', e.message);
    } finally {
      setLoadingInv(false);
    }
  }, [selectedSources]);

  // 进入 Step 2 时自动加载
  useEffect(() => {
    if (step === 2) loadInventories();
  }, [step]);

  // ── Step 2: 饰品多选 ──────────────────────────────────────────────────────────
  const visibleItems = loadedItems.filter(i =>
    !itemSearch || i.name.toLowerCase().includes(itemSearch.toLowerCase()) ||
    i.market_hash_name.toLowerCase().includes(itemSearch.toLowerCase())
  );
  const toggleItem = (assetid) => {
    setSelectedItems(prev => {
      const n = new Set(prev);
      n.has(assetid) ? n.delete(assetid) : n.add(assetid);
      return n;
    });
  };
  const selectAllItems = () => setSelectedItems(new Set(visibleItems.map(i => i.assetid)));
  const clearAllItems = () => setSelectedItems(new Set());

  // ── Step 3: 发送报价 ──────────────────────────────────────────────────────────
  const startTransfer = async () => {
    if (!receiverAccount?.tradeUrl) return;
    setTransferring(true);
    setTransferResults([]);

    // 按来源账号分组 selectedItems
    const bySource = {};
    for (const assetid of selectedItems) {
      const item = loadedItems.find(i => i.assetid === assetid);
      if (!item) continue;
      if (!bySource[item.accountId]) bySource[item.accountId] = [];
      bySource[item.accountId].push(assetid);
    }

    const entries = Object.entries(bySource);
    setTransferResults([]); // clear initial results

    const tasks = entries.map(([fromAccountId, assetIds]) => async () => {
      const fromAcc = accounts.find(a => String(a.id) === String(fromAccountId));
      let resItem;
      try {
        const resp = await api.post('accounts/send-trade-offer', {
          fromAccountId, toTradeUrl: receiverAccount.tradeUrl, assetIds
        });
        resItem = {
          accountName: fromAcc?.name || fromAccountId,
          count: assetIds.length,
          success: true,
          offerId: resp.data.offerId,
          message: resp.data.message
        };
      } catch (e) {
        resItem = {
          accountName: fromAcc?.name || fromAccountId,
          count: assetIds.length,
          success: false,
          message: e.response?.data?.error || e.message
        };
      }
      // 实时追加每一条发送结果
      setTransferResults(prev => [...prev, resItem]);
      return resItem;
    });

    // 并发设置为 10
    await runWithConcurrency(tasks, 10);
    setTransferring(false);
  };

  // ── 撤销所有已发出的 Active 报价 ───────────────────────────────────────────────
  const cancelSentOffers = async () => {
    if (!window.confirm('确认撤销所有账号的待接受报价吗？\n这会撤销所有处于「等待对方接受」状态的交易报价。')) return;
    setCancelling(true);
    setCancelResults(null);
    try {
      const resp = await api.post('accounts/cancel-sent-offers', {});
      setCancelResults(resp.data);
      if (resp.data.totalCancelled > 0) {
        window.alert(`✅ 撤销完成！共撤销 ${resp.data.totalCancelled} 个待接受报价。`);
      } else {
        window.alert('ℹ️ 没有找到待接受的报价，或所有报价已自然过期。');
      }
    } catch (e) {
      window.alert('❌ 撤销失败: ' + (e.response?.data?.error || e.message));
    } finally {
      setCancelling(false);
    }
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────────
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.4rem' }}>📦</span>
            <div>
              <h3 style={styles.title}>库存转移</h3>
              <div style={styles.steps}>
                {['选择账号', '选择饰品', '转移结果'].map((s, i) => (
                  <span key={i} style={{ ...styles.stepBadge, ...(step === i+1 ? styles.stepActive : step > i+1 ? styles.stepDone : {}) }}>
                    {step > i+1 ? '✓ ' : `${i+1}. `}{s}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* ─── Step 1: 选账号 ─── */}
        {step === 1 && (
          <div style={styles.body}>
            {/* 左栏：来源账号 */}
            <div style={styles.col}>
              <div style={styles.colHeader}>
                <span>📤 来源账号 <span style={styles.badge}>{selectedSources.size}</span></span>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button style={styles.miniBtn} onClick={selectAllSources}>全选</button>
                  <button style={styles.miniBtn} onClick={clearAllSources}>清空</button>
                </div>
              </div>
              <div style={styles.scroll}>
                {groupedAccounts.map(grp => {
                  const grpIds = grp.accounts.map(a => String(a.id));
                  const allChk = grpIds.length > 0 && grpIds.every(id => selectedSources.has(id));
                  const someChk = grpIds.some(id => selectedSources.has(id));
                  return (
                    <div key={grp.id} style={styles.group}>
                      <div style={styles.groupHeader} onClick={() => toggleGroupExpand(grp.id)}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: '12px', textAlign: 'center', display: 'inline-block' }}>
                          {expandedGroups.has(grp.id) ? '▼' : '▶'}
                        </span>
                        <input type="checkbox" checked={allChk} ref={el => { if (el) el.indeterminate = !allChk && someChk; }}
                          onChange={(e) => { e.stopPropagation(); toggleGroupSources(grp.accounts); }}
                          onClick={e => e.stopPropagation()}
                          style={{ accentColor: '#38bdf8' }} />
                        <span style={{ fontWeight: 600, color: '#cbd5e1', fontSize: '0.82rem' }}>
                          {grp.name} ({grp.accounts.length})
                        </span>
                      </div>
                      {expandedGroups.has(grp.id) && grp.accounts.map(acc => (
                        <label key={acc.id} style={{
                          ...styles.accRow,
                          ...(String(acc.id) === String(receiverId) ? styles.accRowDisabled : {}),
                          ...(selectedSources.has(String(acc.id)) ? styles.accRowSelected : {})
                        }}>
                          <input type="checkbox"
                            checked={selectedSources.has(String(acc.id))}
                            disabled={String(acc.id) === String(receiverId)}
                            onChange={() => toggleSource(acc.id)}
                            style={{ accentColor: '#38bdf8' }} />
                          <span style={styles.accName}>{acc.name}</span>
                          {acc.banStatus === 'banned' && <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', whiteSpace: 'nowrap' }}>🔴 异常</span>}
                          {acc.banStatus === 'suspicious' && <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.3)', whiteSpace: 'nowrap' }}>🟡 可疑</span>}
                          {acc.banStatus === 'normal' && <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)', whiteSpace: 'nowrap' }}>✅ 正常</span>}
                          {acc.inventoryCount > 0 && <span style={styles.invCount}>{acc.inventoryCount}</span>}
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 分隔线 */}
            <div style={styles.divider} />

            {/* 右栏：接收账号 */}
            <div style={styles.col}>
              <div style={styles.colHeader}>
                <span>📥 接收账号</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>仅限单选</span>
              </div>
              <input style={styles.searchInput} placeholder="搜索账号..."
                value={receiverSearch} onChange={e => setReceiverSearch(e.target.value)} />
              <div style={styles.scroll}>
                {accounts.filter(a =>
                  !receiverSearch || a.name.toLowerCase().includes(receiverSearch.toLowerCase())
                ).map(acc => (
                  <label key={acc.id} style={{
                    ...styles.accRow,
                    ...(selectedSources.has(String(acc.id)) ? styles.accRowDisabled : {}),
                    ...(String(acc.id) === String(receiverId) ? styles.accRowSelected : {})
                  }}>
                    <input type="radio" name="receiver"
                      checked={String(acc.id) === String(receiverId)}
                      disabled={selectedSources.has(String(acc.id))}
                      onChange={() => setReceiverId(acc.id)}
                      style={{ accentColor: '#22c55e' }} />
                    <span style={styles.accName}>{acc.name}</span>
                    {!acc.tradeUrl && <span style={{ fontSize: '0.7rem', color: '#ef4444' }}>无交易链接</span>}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── Step 2: 选饰品 ─── */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', gap: '0.75rem', padding: '0 1.5rem' }}>
            {/* 进度条 */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                <span>加载库存 {loadProgress.done}/{loadProgress.total}</span>
                <span>可交易饰品: {loadedItems.length} 件 | 已选: {selectedItems.size}</span>
              </div>
              <div style={{ height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'var(--accent-color)', width: `${loadProgress.total ? (loadProgress.done/loadProgress.total)*100 : 0}%`, transition: 'width 0.3s' }} />
              </div>
            </div>
            {/* 搜索 + 操作 */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input style={{ ...styles.searchInput, flex: 1 }} placeholder="按名称过滤饰品..."
                value={itemSearch} onChange={e => setItemSearch(e.target.value)} />
              <button style={styles.miniBtn} onClick={selectAllItems}>全选({visibleItems.length})</button>
              <button style={styles.miniBtn} onClick={clearAllItems}>清空</button>
            </div>
            {/* 饰品宫格 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', alignContent: 'start', gap: '0.5rem', overflowY: 'auto', flex: 1, paddingBottom: '0.5rem' }}>
              {visibleItems.map(item => {
                const sel = selectedItems.has(item.assetid);
                return (
                  <div key={item.assetid} onClick={() => toggleItem(item.assetid)}
                    style={{ ...styles.itemCard, ...(sel ? styles.itemCardSelected : {}) }}>
                    <div style={styles.itemCheck}>{sel ? '✓' : ''}</div>
                    <img src={iconUrl(item.icon_url)} alt="" style={styles.itemIcon}
                      onError={e => { e.target.style.display = 'none'; }} />
                    <div style={styles.itemName}>{item.name}</div>
                    <div style={styles.itemFrom}>{item.accountName}</div>
                  </div>
                );
              })}
              {loadingInv && (
                <div style={{ gridColumn: '1/-1', textAlign: 'center', color: 'var(--accent-color)', padding: '1rem', fontSize: '0.9rem', opacity: 0.8 }}>
                  ⏳ 正在通过 SSE 实时接收库存数据...
                </div>
              )}
              {!loadingInv && visibleItems.length === 0 && (
                <div style={{ gridColumn: '1/-1', textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                  暂无可交易饰品
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── Step 3: 转移结果 ─── */}
        {step === 3 && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '0 1.5rem', gap: '1rem' }}>
            <div style={{ padding: '0.75rem 1rem', background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '0.75rem', fontSize: '0.85rem' }}>
              <span style={{ color: '#38bdf8' }}>📥 接收方：</span>
              <span style={{ fontWeight: 600 }}>{receiverAccount?.name}</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>({selectedItems.size} 件饰品)</span>
            </div>
            {transferring && (
              <div style={{ textAlign: 'center', color: 'var(--accent-color)', fontSize: '0.9rem' }}>⏳ 正在发送报价...</div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {transferResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.65rem 1rem', background: r.success ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)', borderRadius: '0.6rem', border: `1px solid ${r.success ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}` }}>
                  <span style={{ fontSize: '1.1rem' }}>{r.success ? '✅' : '❌'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.88rem' }}>{r.accountName}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{r.message}</div>
                  </div>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{r.count} 件</span>
                </div>
              ))}
              {!transferring && transferResults.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                  点击「开始转移」发送所有报价
                </div>
              )}
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        <div style={styles.footer}>
          {step > 1 && !transferring && (
            <button style={styles.btnSecondary} onClick={() => setStep(s => s - 1)}>← 上一步</button>
          )}
          <div style={{ flex: 1 }} />
          {step === 1 && (
            <button style={{ ...styles.btnPrimary, ...(!receiverId || selectedSources.size === 0 ? styles.btnDisabled : {}) }}
              disabled={!receiverId || selectedSources.size === 0}
              onClick={() => setStep(2)}>
              下一步：选择饰品 →
            </button>
          )}
          {step === 1 && (
            <button
              style={{ ...styles.btnSecondary, borderColor: 'rgba(239,68,68,0.4)', color: '#f87171', opacity: cancelling ? 0.6 : 1 }}
              disabled={cancelling}
              onClick={cancelSentOffers}
              title="撤销所有账号中处于等待对方接受状态的交易报价">
              {cancelling ? '⏳ 撤销中...' : '🗑️ 撤销所有待接受报价'}
            </button>
          )}
          {step === 2 && (
            <button style={{ ...styles.btnPrimary, ...(selectedItems.size === 0 || !receiverAccount?.tradeUrl ? styles.btnDisabled : {}) }}
              disabled={selectedItems.size === 0 || !receiverAccount?.tradeUrl}
              onClick={() => setStep(3)}>
              下一步：确认转移 ({selectedItems.size} 件) →
            </button>
          )}
          {step === 3 && !transferring && transferResults.length === 0 && (
            <button style={{ ...styles.btnPrimary, background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}
              onClick={startTransfer}>
              🚀 开始转移
            </button>
          )}
          {step === 3 && transferResults.length > 0 && (
            <button style={styles.btnSecondary} onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 样式常量 ──────────────────────────────────────────────────────────────────
const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(4px)', zIndex: 99999,
    display: 'flex', alignItems: 'center', justifyContent: 'center'
  },
  modal: {
    width: '90vw', maxWidth: '1000px', height: '80vh',
    background: 'var(--card-bg, #1e293b)',
    border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
    borderRadius: '1rem', display: 'flex', flexDirection: 'column',
    overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)'
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--glass-border)',
    flexShrink: 0
  },
  title: { margin: 0, fontSize: '1.1rem', fontWeight: 700 },
  steps: { display: 'flex', gap: '0.5rem', marginTop: '0.3rem' },
  stepBadge: {
    fontSize: '0.72rem', padding: '0.15rem 0.5rem', borderRadius: '4px',
    background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)'
  },
  stepActive: { background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 600 },
  stepDone: { background: 'rgba(34,197,94,0.12)', color: '#22c55e' },
  closeBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-muted)',
    fontSize: '1.5rem', cursor: 'pointer', lineHeight: 1, padding: '0.25rem'
  },
  body: {
    display: 'flex', flex: 1, overflow: 'hidden', gap: 0
  },
  col: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    padding: '1rem 1.5rem'
  },
  colHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '0.75rem', fontWeight: 600, fontSize: '0.88rem'
  },
  divider: { width: '1px', background: 'var(--glass-border)', flexShrink: 0 },
  scroll: { overflowY: 'auto', flex: 1 },
  group: { marginBottom: '0.5rem' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.3rem 0.4rem', cursor: 'pointer'
  },
  accRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.4rem 0.6rem', borderRadius: '6px', cursor: 'pointer',
    fontSize: '0.83rem', transition: 'background 0.15s'
  },
  accRowSelected: { background: 'rgba(56,189,248,0.1)', outline: '1px solid rgba(56,189,248,0.3)' },
  accRowDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  accName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  invCount: {
    fontSize: '0.7rem', padding: '0.1rem 0.4rem', background: 'rgba(255,255,255,0.08)',
    borderRadius: '10px', color: 'var(--text-muted)'
  },
  searchInput: {
    width: '100%', padding: '0.45rem 0.75rem', marginBottom: '0.6rem',
    background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)',
    borderRadius: '6px', color: 'var(--text-main)', fontSize: '0.83rem',
    outline: 'none', boxSizing: 'border-box'
  },
  itemCard: {
    position: 'relative', padding: '0.5rem', borderRadius: '8px',
    background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border)',
    cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: '0.25rem', textAlign: 'center',
    alignSelf: 'start'  // 防止卡片被 grid 拉伸
  },
  itemCardSelected: {
    background: 'rgba(56,189,248,0.1)', borderColor: 'rgba(56,189,248,0.4)',
    boxShadow: '0 0 8px rgba(56,189,248,0.2)'
  },
  itemCheck: {
    position: 'absolute', top: '4px', right: '6px', color: '#38bdf8',
    fontWeight: 700, fontSize: '0.75rem'
  },
  itemIcon: { width: '60px', height: '60px', objectFit: 'contain' },
  itemName: {
    fontSize: '0.72rem', fontWeight: 500, lineHeight: 1.3,
    overflow: 'hidden', textOverflow: 'ellipsis', width: '100%',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'
  },
  itemFrom: { fontSize: '0.65rem', color: 'var(--text-muted)' },
  footer: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '1rem 1.5rem', borderTop: '1px solid var(--glass-border)', flexShrink: 0
  },
  btnPrimary: {
    padding: '0.6rem 1.5rem', borderRadius: '8px', fontWeight: 600, fontSize: '0.9rem',
    background: 'var(--accent-color)', color: '#000', border: 'none', cursor: 'pointer',
    transition: 'opacity 0.15s'
  },
  btnSecondary: {
    padding: '0.6rem 1.2rem', borderRadius: '8px', fontWeight: 500, fontSize: '0.9rem',
    background: 'rgba(255,255,255,0.07)', color: 'var(--text-main)',
    border: '1px solid var(--glass-border)', cursor: 'pointer'
  },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  miniBtn: {
    padding: '0.25rem 0.6rem', borderRadius: '5px', fontSize: '0.75rem',
    background: 'rgba(255,255,255,0.07)', color: 'var(--text-muted)',
    border: '1px solid var(--glass-border)', cursor: 'pointer'
  },
  badge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: '18px', height: '18px', borderRadius: '9px',
    background: '#38bdf8', color: '#000', fontSize: '0.7rem', fontWeight: 700,
    padding: '0 4px', verticalAlign: 'middle', marginLeft: '4px'
  }
};
