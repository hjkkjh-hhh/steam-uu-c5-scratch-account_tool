import React, { useState, useRef, useEffect } from 'react';
import { getAuthHeaders } from './api';

const RedLetterScanner = ({ onClose }) => {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [scanResults, setScanResults]     = useState([]);
  const [isScanning, setIsScanning]       = useState(false);
  const [progress, setProgress]           = useState({ current: 0, total: 0 });
  const [error, setError]                 = useState(null);

  // 显示维度的开关
  const [filters, setFilters] = useState({
    community: true, 
    vac:       false,
    gameBan:   false
  });

  const resultsEndRef = useRef(null);

  useEffect(() => {
    if (isScanning) resultsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [scanResults, isScanning]);

  // ── 统计 ───────────────────────────────────────────────────────────
  const stats = scanResults.reduce((acc, r) => {
    acc.total++;
    // 根据用户业务逻辑，只要吃到了社区或VAC封禁，即视为交易封禁 (trade banned)
    if (r.communityBanned)            acc.community++;
    if (r.vacBanned)                  acc.vac++;
    if (r.numberOfGameBans > 0)       acc.gameBan++;
    
    const isSusp = r.isSuspicious ?? (!r.isBanned && (r.numberOfGameBans > 0 || r.economyBan === 'probation'));
    if (r.isBanned)                   acc.tradeBanned++;
    else if (isSusp)                  acc.suspicious++;
    else                              acc.normal++;
    return acc;
  }, { total: 0, normal: 0, suspicious: 0, community: 0, vac: 0, gameBan: 0, tradeBanned: 0 });

  // ── 文件选择 ────────────────────────────────────────────────────────
  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    setSelectedFiles(files);
    setScanResults([]);
    setProgress({ current: 0, total: files.length });
    setError(null);
  };

  // ── 扫描 ────────────────────────────────────────────────────────────
  const startScan = async () => {
    if (!selectedFiles.length) return;
    setIsScanning(true);
    setScanResults([]);
    setProgress({ current: 0, total: selectedFiles.length });
    setError(null);

    const fileContents = await Promise.all(
      selectedFiles.map(file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve({ name: file.name, content: e.target.result });
        reader.readAsText(file);
      }))
    );

    try {
      const response = await fetch('/api/accounts/scan-red-letters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ maFiles: fileContents }),
      });
      if (!response.ok) throw new Error('启动扫描失败');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let counted = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const raw of parts) {
          if (!raw.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(raw.slice(6));
            if (data.done) { setIsScanning(false); continue; }
            if (data.result && data.result.steamId64) {
              counted++;
              setScanResults(prev => [...prev, data.result]);
              setProgress({ current: counted, total: fileContents.length });
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      setError(e.message);
      setIsScanning(false);
    }
  };

  // ── 辅助渲染 ─────────────────────────────────────────────────────────
  const BoolCell = ({ val, label }) =>
    val
      ? <span className="ban-chip red">🔴 {label}</span>
      : <span className="ban-chip green">✅ 正常</span>;

  const toggleFilter = key =>
    setFilters(f => ({ ...f, [key]: !f[key] }));

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="rls-wrap">
      {/* 标题栏 */}
      <div className="rls-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ fontSize: '1.4rem' }}>🛡️</span>
          <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Steam 账号封禁批量检测</h2>
        </div>
        <button className="rls-close" onClick={onClose}>×</button>
      </div>

      {/* 上传 + 开始 */}
      <div className="rls-controls">
        <div className="rls-upload-zone">
          <input type="file" id="rls-file-input" multiple accept=".maFile"
            onChange={handleFileChange} disabled={isScanning} />
          <label htmlFor="rls-file-input" className={`rls-upload-label ${isScanning ? 'disabled' : ''}`}>
            {selectedFiles.length > 0
              ? `📁 已选 ${selectedFiles.length} 个 maFile`
              : '📁 点击或拖拽上传 maFile 令牌文件'}
          </label>
        </div>
        <button className="rls-scan-btn" onClick={startScan}
          disabled={isScanning || !selectedFiles.length}>
          {isScanning ? '⏳ 检测中...' : '🔍 开始检测'}
        </button>
      </div>

      {error && <div className="rls-error">⚠️ {error}</div>}

      {/* 过滤器开关 */}
      <div className="rls-filter-bar">
        <span className="rls-filter-label">显示列：</span>
        {[
          { key: 'community', label: '🔴 社区封禁', color: '#ef4444' },
          { key: 'vac',       label: '☣️ VAC封禁',  color: '#a855f7' },
          { key: 'gameBan',   label: '🟡 游戏封禁',  color: '#eab308' },
        ].map(({ key, label, color }) => (
          <button
            key={key}
            className={`rls-filter-btn ${filters[key] ? 'active' : ''}`}
            style={filters[key] ? { borderColor: color, color, background: `${color}18` } : {}}
            onClick={() => toggleFilter(key)}
          >
            {label}
            {key === 'community' && stats.community > 0 &&
              <span className="rls-filter-badge" style={{ background: '#ef4444' }}>
                {stats.community}
              </span>}
            {key === 'vac'       && stats.vac > 0 &&
              <span className="rls-filter-badge" style={{ background: '#a855f7' }}>
                {stats.vac}
              </span>}
            {key === 'gameBan'   && stats.gameBan > 0 &&
              <span className="rls-filter-badge" style={{ background: '#eab308' }}>
                {stats.gameBan}
              </span>}
          </button>
        ))}
      </div>

      {/* 统计卡片 + 进度条 */}
      {(scanResults.length > 0 || isScanning) && (
        <div className="rls-body">
          <div className="rls-stats">
            {[
              { label: '总数',     value: progress.total,        cls: '' },
              { label: '✅ 正常',  value: stats.normal,          cls: 'green' },
              { label: '🟡 可疑',  value: stats.suspicious,      cls: 'yellow' },
              { label: '🔴 无法交易',value: stats.tradeBanned,   cls: 'red' },
              { label: '🔴 社区',  value: stats.community,       cls: 'red', hide: !filters.community },
              { label: '☣️ VAC',   value: stats.vac,             cls: 'purple', hide: !filters.vac },
              { label: '🟡 游戏',   value: stats.gameBan,        cls: 'yellow', hide: !filters.gameBan },
              { label: '进度',     value: `${pct}%`,             cls: '' },
            ].filter(s => !s.hide).map(({ label, value, cls }) => (
              <div key={label} className={`rls-stat-card ${cls}`}>
                <span className="rls-stat-label">{label}</span>
                <span className="rls-stat-value">{value}</span>
              </div>
            ))}
          </div>

          <div className="rls-progress-bar">
            <div className="rls-progress-fill" style={{ width: `${pct}%` }} />
          </div>

          {/* 结果表格 */}
          <div className="rls-table-wrap">
            <table className="rls-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>账号名</th>
                  {filters.community && <th>🔴 社区封禁</th>}
                  {filters.vac       && <th>☣️ VAC封禁</th>}
                  {filters.gameBan   && <th>🟡 游戏封禁</th>}
                  <th>综合状态</th>
                </tr>
              </thead>
              <tbody>
                {scanResults.map((r, i) => {
                  const isSusp = r.isSuspicious ?? (!r.isBanned && (r.numberOfGameBans > 0 || r.economyBan === 'probation'));
                  return (
                  <tr key={i} className={`rls-row ${r.isBanned ? 'banned' : isSusp ? 'suspicious' : 'clean'} fadeIn`}>
                    <td className="rls-idx">{i + 1}</td>
                    <td className="rls-name">{r.name}</td>
                    {filters.community && <td><BoolCell val={r.communityBanned} label="社区封禁" /></td>}
                    {filters.vac       && <td>
                      {r.vacBanned
                        ? <span className="ban-chip purple">☣️ VAC×{r.numberOfVACBans}({r.daysSinceLastBan}天前)</span>
                        : <span className="ban-chip green">✅ 正常</span>}
                    </td>}
                    {filters.gameBan   && <td>
                      {r.numberOfGameBans > 0
                        ? <span className="ban-chip yellow">🟡 游戏×{r.numberOfGameBans}</span>
                        : <span className="ban-chip green">✅ 正常</span>}
                    </td>}
                    <td>
                      <span className={`ban-chip ${r.isBanned ? 'red' : isSusp ? 'yellow' : 'green'}`}>
                        {r.isBanned ? '🔴 无法交易' : isSusp ? '🟡 可疑' : '✅ 正常'}
                      </span>
                    </td>
                  </tr>
                )})}
                {isScanning && progress.current < progress.total && (
                  <tr className="rls-scanning-row">
                    <td colSpan="10">⏳ 正在查询第 {progress.current + 1} / {progress.total} 个...</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div ref={resultsEndRef} />
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .rls-wrap { display: flex; flex-direction: column; gap: 1.2rem; color: var(--text-main); }
        .rls-header { display: flex; justify-content: space-between; align-items: center;
          border-bottom: 1px solid var(--glass-border); padding-bottom: 1rem; }
        .rls-close { background: transparent; border: none; color: var(--text-muted);
          font-size: 1.5rem; cursor: pointer; line-height: 1; }
        .rls-controls { display: flex; gap: 1rem; align-items: center; }
        .rls-upload-zone { flex: 1; }
        #rls-file-input { display: none; }
        .rls-upload-label {
          display: block; padding: 0.7rem 1rem;
          background: rgba(255,255,255,0.04); border: 1px dashed var(--glass-border);
          border-radius: 0.75rem; text-align: center; cursor: pointer;
          transition: all 0.2s; font-size: 0.9rem; color: var(--text-muted); }
        .rls-upload-label:hover { border-color: var(--accent-color);
          background: rgba(56,189,248,0.08); color: var(--text-main); }
        .rls-upload-label.disabled { opacity: 0.5; cursor: not-allowed; }
        .rls-scan-btn {
          background: var(--accent-color); color: #000; border: none;
          padding: 0.7rem 1.5rem; border-radius: 0.75rem;
          font-weight: 700; cursor: pointer; transition: all 0.2s; white-space: nowrap; }
        .rls-scan-btn:hover:not(:disabled) { transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(56,189,248,0.4); }
        .rls-scan-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .rls-error { background: rgba(239,68,68,0.1); color: #ef4444;
          padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #ef4444; font-size: 0.9rem; }

        /* ── 过滤器 ── */
        .rls-filter-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
        .rls-filter-label { font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; }
        .rls-filter-btn {
          position: relative; display: flex; align-items: center; gap: 0.4rem;
          padding: 0.4rem 0.9rem; border-radius: 2rem; border: 1px solid var(--glass-border);
          background: rgba(255,255,255,0.04); color: var(--text-muted);
          font-size: 0.82rem; cursor: pointer; transition: all 0.2s; }
        .rls-filter-btn:hover { border-color: var(--accent-color); color: var(--text-main); }
        .rls-filter-btn.active { font-weight: 600; }
        .rls-filter-badge {
          position: absolute; top: -6px; right: -6px;
          padding: 0 5px; border-radius: 10px; font-size: 0.65rem;
          font-weight: 700; color: #fff; min-width: 16px; text-align: center; }

        /* ── 统计卡片 ── */
        .rls-stats { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
        .rls-stat-card {
          flex: 1; min-width: 70px; background: rgba(255,255,255,0.03);
          border: 1px solid var(--glass-border); border-radius: 0.75rem;
          padding: 0.6rem; text-align: center; }
        .rls-stat-label { display: block; font-size: 0.7rem; color: var(--text-muted); margin-bottom: 2px; }
        .rls-stat-value { font-size: 1.15rem; font-weight: 700; }
        .rls-stat-card.green .rls-stat-value { color: #22c55e; }
        .rls-stat-card.red   .rls-stat-value { color: #ef4444; }
        .rls-stat-card.yellow .rls-stat-value { color: #f59e0b; }
        .rls-stat-card.purple .rls-stat-value { color: #a855f7; }
        .rls-stat-card.blue   .rls-stat-value { color: #38bdf8; }

        .rls-progress-bar { height: 5px; background: rgba(255,255,255,0.08);
          border-radius: 3px; overflow: hidden; margin-bottom: 1rem; }
        .rls-progress-fill { height: 100%; background: var(--accent-color);
          transition: width 0.3s ease; box-shadow: 0 0 8px var(--accent-color); }

        /* ── 表格 ── */
        .rls-table-wrap { max-height: 420px; overflow-y: auto;
          border: 1px solid var(--glass-border); border-radius: 0.75rem;
          background: rgba(0,0,0,0.15); }
        .rls-table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
        .rls-table th { position: sticky; top: 0; background: #1e293b;
          padding: 0.65rem 0.75rem; text-align: left;
          color: var(--text-muted); border-bottom: 1px solid var(--glass-border); z-index: 5; }
        .rls-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .rls-row.banned td { background: rgba(239,68,68,0.04); }
        .rls-row.suspicious td { background: rgba(245,158,11,0.04); }
        .rls-row.clean  td { background: transparent; }
        .rls-row:hover  td { background: rgba(255,255,255,0.04); }
        .rls-idx  { color: var(--text-muted); width: 36px; text-align: center; }
        .rls-name { font-weight: 500; }
        .rls-scanning-row td { text-align: center; color: var(--accent-color);
          font-style: italic; padding: 0.75rem; }

        /* ── 封禁状态徽章 ── */
        .ban-chip { display: inline-block; padding: 0.2rem 0.55rem;
          border-radius: 4px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
        .ban-chip.red    { background: rgba(239,68,68,0.12); color: #ef4444; }
        .ban-chip.yellow { background: rgba(245,158,11,0.12); color: #f59e0b; }
        .ban-chip.green  { background: rgba(34,197,94,0.12); color: #22c55e; }
        .ban-chip.purple { background: rgba(168,85,247,0.12); color: #a855f7; }
        .ban-chip.blue   { background: rgba(56,189,248,0.12); color: #38bdf8; }


        .fadeIn { animation: fadeIn 0.25s ease-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); }
                            to   { opacity: 1; transform: translateY(0); } }
      `}} />
    </div>
  );
};

export default RedLetterScanner;
