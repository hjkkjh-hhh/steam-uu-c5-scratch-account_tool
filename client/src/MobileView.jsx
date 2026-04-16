import React, { useState, useMemo, useEffect } from 'react';
import api from './api';
import './MobileApp.css';

const MobileView = ({
  trackedItems,
  cashOutTop,
  topUpTop,
  seriesResults,
  steamAccounts,
  activeAccountId,
  setActiveAccountId,
  settings,
  setSettings,
  inventorySummary,
  updateSettings,
  handleManualUpdate,
  handleDeleteSeries,
  handleToggleExcludeSeries,
  handleSeriesIntervalChange,
  handleMoveSeries,
  handleSearch,
  addTrack,
  addBatchToTrack,
  handleLogin,
  requiresLogin,
  passwordInput,
  setPasswordInput,
  syncWealth,
  notifications,
  removeNotification,
  updatingSeries,
  isSyncing,
  loading,
  error,
  item,
  setItem,
  activeTab,
  setActiveTab,
  // New Props for Feature Parity
  isInventoryModalOpen,
  setIsInventoryModalOpen,
  inventoryData,
  inventoryLoading,
  fetchInventory,
  fetchInventorySummary,
  isAccountModalOpen,
  setIsAccountModalOpen,
  addAccount,
  updateAccount,
  deleteAccount,
  isAlertModalOpen,
  setIsAlertModalOpen,
  alertItem,
  setAlertItem,
  handleSaveAlert,
  isAlertManagerOpen,
  setIsAlertManagerOpen,
  viewingAccountName,
  openSellDialog,
  confirmSell,
  sellDialog,
  setSellDialog,
  isSelling,
  sellSellerPrice,
  sellBuyerPrice,
  handleSellerPriceChange,
  handleBuyerPriceChange,
  sellQuantity,
  setSellQuantity,
  marketPriceInfo,
  selectedInterval,
  setSelectedInterval,
  selectedHashNames,
  setSelectedHashNames,
  showSearchStatTrak,
  setShowSearchStatTrak,
  searchMinPrice,
  setSearchMinPrice,
  searchMaxPrice,
  setSearchMaxPrice,
  isBatchSellModalOpen,
  setIsBatchSellModalOpen,
  saveDingTalkSettings,
  testDingTalk,
  dingTalkWebhookInput,
  setDingTalkWebhookInput,
  dingTalkSecretInput,
  setDingTalkSecretInput,
  steamCookieInput,
  setSteamCookieInput,
  dingTalkSaving
}) => {
  const [expandedSeries, setExpandedSeries] = useState(new Set());
  const [activeModal, setActiveModal] = useState(null); // 'inventory', 'account', 'alertManager', 'sell', 'itemAlert', 'batchSell'
  
  // Inventory Management State
  const [selectedAssets, setSelectedAssets] = useState(new Set());
  const [invSearch, setInvSearch] = useState('');
  const [batchStrategy, setBatchStrategy] = useState('auto'); // 'auto', 'fixed'
  const [batchFixedPrice, setBatchFixedPrice] = useState('0.10');
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  useEffect(() => {
    if (sellDialog) setActiveModal('sell');
    else if (isBatchSellModalOpen) setActiveModal('batchSell');
    else if (isAlertModalOpen) setActiveModal('itemAlert');
    else if (isInventoryModalOpen) setActiveModal('inventory');
    else if (isAccountModalOpen) setActiveModal('account');
    else if (isAlertManagerOpen) setActiveModal('alertManager');
    else setActiveModal(null);
  }, [isInventoryModalOpen, isAccountModalOpen, isAlertManagerOpen, isAlertModalOpen, isBatchSellModalOpen, sellDialog]);

  const closeModal = () => {
    if (activeModal === 'sell') setSellDialog(null);
    else if (activeModal === 'batchSell') setIsBatchSellModalOpen(false);
    else if (activeModal === 'itemAlert') setIsAlertModalOpen(false);
    else if (activeModal === 'inventory') setIsInventoryModalOpen(false);
    else if (activeModal === 'account') setIsAccountModalOpen(false);
    else if (activeModal === 'alertManager') setIsAlertManagerOpen(false);
    else setActiveModal(null);
  };

  const activeAcc = steamAccounts.find(a => String(a.id) === String(activeAccountId));

  // ── Utils ────────────────────────────────────────────────────────────────
  const getRatio = (steamCNY, c5Price) => {
    if (!steamCNY || !c5Price || c5Price === 'N/A') return null;
    const s = parseFloat(steamCNY.toString().replace(/[^\d.]/g, ''));
    const y = parseFloat(c5Price);
    if (isNaN(s) || isNaN(y) || s === 0) return null;
    return (y / s).toFixed(3);
  };

  const getProfitInfo = (steamCNY, c5Price) => {
    if (!steamCNY || !c5Price || c5Price === 'N/A') return { diff: '0.00', percent: '0.0', isProfit: false };
    const s = parseFloat(steamCNY.toString().replace(/[^\d.]/g, ''));
    const y = parseFloat(c5Price);
    if (isNaN(s) || isNaN(y)) return { diff: '0.00', percent: '0.0', isProfit: false };
    const diff = (s - y).toFixed(2);
    const percent = ((s - y) / y * 100).toFixed(1);
    return { diff, percent, isProfit: s > y };
  };

  const getRarityColor = (typeString) => {
    if (!typeString) return '#B0C3D9';
    if (typeString.includes('Covert') || typeString.includes('隐秘')) return '#EB4B4B';
    if (typeString.includes('Classified') || typeString.includes('保密')) return '#D32CE6';
    if (typeString.includes('Restricted') || typeString.includes('受限')) return '#8847FF';
    if (typeString.includes('Mil-Spec Grade') || typeString.includes('军规级')) return '#4B69FF';
    if (typeString.includes('Industrial Grade') || typeString.includes('工业级')) return '#5E98D9';
    if (typeString.includes('Consumer Grade') || typeString.includes('消费级')) return '#B0C3D9';
    return '#FFFFFF';
  };

  const toggleExpand = (key) => {
    // Debug for user
    if (window._mobileDebug) window.alert('点击系列: ' + key);
    setExpandedSeries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Grouping logic ───────────────────────────────────────────────────────
  const getGroupKey = (ti) => {
    let base = (ti.name || ti.hashName || '')
      .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
      .replace(/\s*[（(].*?[）)]\s*$/, '');
    const tournamentMatch = base.match(/^(\d{4}年.*?锦标赛|.*? \d{4})\b/);
    if (tournamentMatch) return tournamentMatch[1];
    if (base.toLowerCase().includes('case') || base.toLowerCase().includes('capsule')) {
      base = base.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
    }
    return base;
  };

  const groupedSeries = useMemo(() => {
    const map = new Map();
    trackedItems.forEach(ti => {
      const key = getGroupKey(ti);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ti);
    });
    return Array.from(map.entries());
  }, [trackedItems]);

  // ── Modals & Sub-Views ────────────────────────────────────────────────────

  const renderModal = (title, content, footerButtons = []) => (
    <div className="m-modal-overlay fadeIn" onClick={closeModal}>
      <div className="m-modal-container glass-effect" onClick={e => e.stopPropagation()}>
        <div className="m-modal-header">
          <h3>{title}</h3>
          <button className="m-modal-close" onClick={closeModal}>×</button>
        </div>
        <div className="m-modal-body custom-scrollbar">
          {content}
        </div>
        {footerButtons.length > 0 && (
          <div className="m-modal-footer">
            {footerButtons.map((btn, i) => (
              <button key={i} className={btn.className} onClick={btn.onClick}>{btn.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderInventoryContent = () => {
    if (inventoryLoading) return <div className="m-loading-center"><div className="m-spinner"></div><p>正在拉取库存...</p></div>;
    if (!inventoryData) return <div className="m-empty">暂无库存数据</div>;

    // Build classid_instanceid -> assetid lookup
    const assetMap = new Map();
    if (inventoryData.assets) {
      inventoryData.assets.forEach(a => {
        const key = `${a.classid}_${a.instanceid}`;
        if (!assetMap.has(key)) assetMap.set(key, []);
        assetMap.get(key).push(a.assetid);
      });
    }

    const items = inventoryData.descriptions
      .filter(item => {
        const nameStr = item.market_bucket_group_name || item.name || item.market_name || '';
        if (nameStr.includes('挂件拆卸器包') || nameStr.includes('涂鸦')) return false;
        if (item.marketable !== 1) return false;
        return !invSearch || nameStr.toLowerCase().includes(invSearch.toLowerCase());
      })
      .map(item => {
        const assetids = assetMap.get(`${item.classid}_${item.instanceid}`) || [];
        const rarityTag = item.tags?.find(t => t.category === 'Rarity');
        const rColor = rarityTag?.color ? `#${rarityTag.color}` : 'rgba(255,255,255,0.1)';
        return {
          ...item,
          assetids,
          displayName: item.market_name || item.name,
          image: `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/128fx128f`,
          rarityColor: rColor
        };
      });

    const toggleItem = (key) => {
      const next = new Set(selectedAssets);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelectedAssets(next);
    };

    return (
      <div className="m-inventory-view">
        <div className="m-inv-search-bar">
          <input 
            type="text" 
            placeholder="搜索关键词..." 
            value={invSearch} 
            onChange={e => setInvSearch(e.target.value)} 
          />
          <button onClick={() => {
            if (selectedAssets.size === items.length) setSelectedAssets(new Set());
            else setSelectedAssets(new Set(items.map(item => `${item.classid}_${item.instanceid}`)));
          }}>
            {selectedAssets.size === items.length ? '取消' : '全选'}
          </button>
        </div>

        <div className="m-inventory-grid">
          {items.map((item, i) => {
            const itemKey = `${item.classid}_${item.instanceid}`;
            const isSelected = selectedAssets.has(itemKey);
            const qty = item.assetids.length;

            return (
              <div 
                key={itemKey + i} 
                className={`m-inventory-card ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleItem(itemKey)}
              >
                <div className="m-inv-card-img" style={{ borderBottom: `2px solid ${item.rarityColor}` }}>
                  {item.image && <img src={item.image} alt="" />}
                  {isSelected && <div className="m-selection-check">✓</div>}
                  {qty > 1 && <div className="m-item-qty-badge">x{qty}</div>}
                </div>
                <div className="m-inv-card-name">{item.displayName}</div>
                {!inventoryData.isTotalView && item.assetids.length > 0 && (
                  <button 
                    className="m-inv-sell-btn" 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      openSellDialog({ ...item, name: item.displayName }, item.assetids); 
                    }}
                  >
                    上架
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {selectedAssets.size > 0 && (
          <div className="m-inv-batch-bar bounceInUp">
            <div className="m-batch-info">已选 <strong>{selectedAssets.size}</strong> 组饰品</div>
            <button className="m-btn-primary" onClick={() => setIsBatchSellModalOpen(true)}>
              批量上架
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderAccountManager = () => (
    <div className="m-account-list">
      {steamAccounts.map(acc => (
        <div key={acc.id} className="m-account-item-card">
          <div className="m-account-item-header">
            <input 
              className="m-input-ghost" 
              value={acc.name} 
              onChange={e => updateAccount(acc.id, 'name', e.target.value)}
            />
            <button className="m-icon-btn danger sm" onClick={() => deleteAccount(acc.id)}>🗑️</button>
          </div>
          <div className="m-account-item-field">
            <label>Profile:</label>
            <input className="m-input-sm" value={acc.profile} onChange={e => updateAccount(acc.id, 'profile', e.target.value)} />
          </div>
          <div className="m-account-item-field">
            <label>Path:</label>
            <input className="m-input-sm" value={acc.profilePath} onChange={e => updateAccount(acc.id, 'profilePath', e.target.value)} />
          </div>
        </div>
      ))}
      <button className="m-btn-secondary" onClick={addAccount}>+ 添加新账号</button>
    </div>
  );

  const renderAlertContent = () => {
    if (!alertItem) return null;
    return (
      <div className="m-alert-setup">
        <div className="m-alert-target">
          <img src={alertItem.image} alt="" />
          <div>{alertItem.name}</div>
        </div>
        <div className="m-form-group">
          <label>价格下限 (¥)</label>
          <input 
            type="number" className="m-input" placeholder="低于此价提醒" 
            defaultValue={alertItem.minAlert || ''} 
            onBlur={e => handleSaveAlert(alertItem, e.target.value, alertItem.maxAlert, alertItem.minRatioAlert, alertItem.maxRatioAlert)}
          />
        </div>
        <div className="m-form-group">
          <label>价格上限 (¥)</label>
          <input 
            type="number" className="m-input" placeholder="高于此价提醒" 
            defaultValue={alertItem.maxAlert || ''} 
            onBlur={e => handleSaveAlert(alertItem, alertItem.minAlert, e.target.value, alertItem.minRatioAlert, alertItem.maxRatioAlert)}
          />
        </div>
        <div className="m-alert-hint">设置后将立即同步至服务器</div>
      </div>
    );
  };

  const renderSellDialogContent = () => {
    if (!sellDialog) return null;
    return (
      <div className="m-sell-view">
        <div className="m-sell-target">
          <img src={sellDialog.item.image} alt="" />
          <div>{sellDialog.item.name || sellDialog.item.market_name}</div>
        </div>
        
        <div className="m-market-price-hint">
          {marketPriceInfo?.loading ? '查询底价中...' : (
            marketPriceInfo?.lowest_price ? 
              `最低售价: ${marketPriceInfo.lowest_price}${marketPriceInfo.listings ? ` (${marketPriceInfo.listings} 件)` : ''}` : 
              '暂无底价信息'
          )}
        </div>

        <div className="m-sell-form">
          <div className="m-form-row">
            <div className="m-form-group">
              <label>到手价 (¥)</label>
              <input type="number" step="0.01" className="m-input" value={sellSellerPrice} onChange={e => handleSellerPriceChange(e.target.value)} />
            </div>
            <div className="m-form-group">
              <label>买家支付 (¥)</label>
              <input type="number" step="0.01" className="m-input" value={sellBuyerPrice} onChange={e => handleBuyerPriceChange(e.target.value)} />
            </div>
          </div>
          <div className="m-form-group">
            <label>数量 (1 - {sellDialog.assetids?.length || 1})</label>
            <input type="number" className="m-input" value={sellQuantity} onChange={e => setSellQuantity(e.target.value)} />
          </div>
        </div>
        
        <button className="m-btn-primary full-width" onClick={confirmSell} disabled={isSelling}>
          {isSelling ? '正在挂售...' : `确认挂售 (共 ${sellQuantity} 件)`}
        </button>
      </div>
    );
  };

  const renderBatchSellContent = () => {
    // Reconstruct asset mapping
    const assetMap = new Map();
    if (inventoryData?.assets) {
      inventoryData.assets.forEach(a => {
        const key = `${a.classid}_${a.instanceid}`;
        if (!assetMap.has(key)) assetMap.set(key, []);
        assetMap.get(key).push(a.assetid);
      });
    }

    const selectedList = (inventoryData?.descriptions || [])
      .filter(d => selectedAssets.has(`${d.classid}_${d.instanceid}`))
      .map(d => ({
        ...d,
        assetids: assetMap.get(`${d.classid}_${d.instanceid}`) || [],
        name: d.market_name || d.name
      }));
    
    const handleConfirmBatch = async () => {
      setBatchProcessing(true);
      
      const itemsToSell = [];
      const accountId = activeAccountId;

      // Iterate through all actual assets for each selected description
      for (const group of selectedList) {
        let sellerPriceFen = 0;

        if (batchStrategy === 'auto') {
          try {
            const res = await api.get('market-price', { params: { hashName: group.market_hash_name || group.name } });
            if (res.data?.lowest_price) {
              const buyerPayFen = Math.round(parseFloat(res.data.lowest_price.replace(/[^\d.]/g, '')) * 100);
              sellerPriceFen = steamBuyerToSellerFen(buyerPayFen);
            }
          } catch (e) { console.warn(`Batch Price fetch failed for ${group.name}`); }
        } else {
          sellerPriceFen = Math.round(parseFloat(batchFixedPrice) * 100);
        }

        if (sellerPriceFen > 0) {
          group.assetids.forEach(assetid => {
            itemsToSell.push({
              assetid: assetid,
              sellerPriceFen,
              itemName: group.name
            });
          });
        }
      }

      if (itemsToSell.length === 0) {
        alert('未获取到有效上架价格');
        setBatchProcessing(false);
        return;
      }

      setBatchProgress({ current: 0, total: itemsToSell.length });

      try {
        const results = await handleBatchSell(accountId, itemsToSell);
        alert(`批量处理完成！\n成功: ${results.successCount}\n失败: ${results.failed.length}`);
        fetchInventorySummary();
        setActiveModal(null); 
        setIsBatchSellModalOpen(false);
        setSelectedAssets(new Set());
      } catch (e) {
        alert('批量上架失败');
      } finally {
        setBatchProcessing(false);
      }
    };

    return (
      <div className="m-batch-sell-view">
        <div className="m-batch-header">
          准备上架 <strong>{selectedList.length}</strong> 件饰品
        </div>
        
        <div className="m-strategy-selector">
          <div className={`m-strat-card ${batchStrategy === 'auto' ? 'active' : ''}`} onClick={() => setBatchStrategy('auto')}>
            <div className="m-strat-icon">🤖</div>
            <div className="m-strat-text">智能底价 (底价 - 0.01)</div>
          </div>
          <div className={`m-strat-card ${batchStrategy === 'fixed' ? 'active' : ''}`} onClick={() => setBatchStrategy('fixed')}>
            <div className="m-strat-icon">💰</div>
            <div className="m-strat-text">统一实得价 (¥)</div>
            {batchStrategy === 'fixed' && (
              <input 
                type="number" step="0.01" className="m-input-sm" 
                value={batchFixedPrice} onChange={e => setBatchFixedPrice(e.target.value)} 
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
        </div>

        <div className="m-batch-preview custom-scrollbar">
          {selectedList.map(item => (
            <div key={`${item.classid}_${item.instanceid}`} className="m-preview-row">
               <img src={item.image} alt="" />
               <span>{item.name}</span>
            </div>
          ))}
        </div>

        <button className="m-btn-primary full-width" onClick={handleConfirmBatch} disabled={batchProcessing}>
          {batchProcessing ? '顺序处理中，请稍候...' : '立刻批量上架'}
        </button>
      </div>
    );
  };

  // ── Tab Rendering ─────────────────────────────────────────────────────────

  const renderTracked = () => {
    if (groupedSeries.length === 0) return <div className="m-empty">暂无追踪饰品</div>;
    return (
      <div className="m-list">
        {groupedSeries.map(([key, subs]) => {
          const first = subs[0];
          const isExpanded = expandedSeries.has(key);
          const updating = updatingSeries?.has(key);
          return (
            <div key={key} className={`m-card-stack ${isExpanded ? 'expanded' : ''}`}>
              <button className="m-card-main" onClick={() => toggleExpand(key)}>
                <div className="m-card-img-slot">
                  {first.image ? <img src={first.image} alt="" /> : <span>🎮</span>}
                </div>
                <div className="m-card-info-slot">
                  <div className="m-card-title">{key}</div>
                  <div className="m-card-subtitle">{subs.length} 个版本 | 余额比 {getRatio(first.steamPrices?.CNY, first.lastC5Price) || 'N/A'}</div>
                </div>
                <div className="m-card-right-slot">
                  <button className={`m-icon-btn ${updating?'spin':''}`} onClick={e => { e.stopPropagation(); handleManualUpdate(key); }} disabled={updating}>🔄</button>
                </div>
              </button>
              {isExpanded && (
                <div className="m-card-details slideDown">
                  <div className="m-series-controls">
                    <div className="m-control-group">
                      <label>更新频率:</label>
                      <select 
                        value={first.interval || 30} 
                        onChange={e => handleSeriesIntervalChange(key, e.target.value)}
                        className="m-select-sm"
                      >
                        {[10, 20, 30, 60].map(v => <option key={v} value={v}>{v}m</option>)}
                      </select>
                    </div>
                    <div className="m-control-actions">
                      <button 
                        className={`m-btn-pill ${first.excludeFromRanking ? 'active' : ''}`}
                        onClick={() => handleToggleExcludeSeries(key, !first.excludeFromRanking)}
                      >
                        {first.excludeFromRanking ? '已屏蔽排行' : '显示在排行'}
                      </button>
                      <div className="m-move-btns">
                        <button onClick={() => handleMoveSeries(key, 'up')}>↑</button>
                        <button onClick={() => handleMoveSeries(key, 'down')}>↓</button>
                      </div>
                    </div>
                  </div>

                  {subs.map(sub => {
                    const profitInfo = getProfitInfo(sub.steamPrices?.CNY, sub.lastC5Price);
                    return (
                      <div key={sub.hashName} className="m-sub-item">
                        <div className="m-sub-name">{sub.name || sub.hashName}</div>
                        <div className="m-sub-price-grid">
                           <div className="m-price-entry">
                             <label>Steam:</label>
                             <span>{sub.steamPrices?.CNY || 'N/A'}</span>
                           </div>
                           <div className="m-price-entry">
                             <label>C5:</label>
                             <span>¥{sub.lastC5Price}</span>
                           </div>
                           <div className="m-price-entry">
                             <label>利润:</label>
                             <span className={profitInfo.isProfit ? 'text-profit' : 'text-loss'}>
                               {profitInfo.isProfit ? '+' : ''}{profitInfo.diff}
                             </span>
                           </div>
                           <div className="m-price-entry">
                             <label>比例:</label>
                             <span className="m-sub-ratio">{getRatio(sub.steamPrices?.CNY, sub.lastYoupinPrice)}</span>
                           </div>
                           <div className="m-price-entry">
                             <label>百分比:</label>
                             <span className={profitInfo.isProfit ? 'text-profit' : 'text-loss'}>
                               {profitInfo.percent}%
                             </span>
                           </div>
                        </div>
                        <div className="m-sub-actions">
                          <button className="m-btn-icon-sm" onClick={() => { setAlertItem(sub); setIsAlertModalOpen(true); }}>🔔</button>
                          <button className="m-btn-icon-sm danger" onClick={() => removeFromTracked(sub.hashName)}>🗑️</button>
                        </div>
                      </div>
                    );
                  })}
                  <button className="m-btn-text danger" onClick={() => handleDeleteSeries(key, subs.length)}>删除整个系列</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderSearch = () => (
    <div className="m-search-view">
      <div className="m-search-bar">
        <input className="m-input" placeholder="输入系列或名称..." value={item} onChange={e=>setItem(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} />
        <button className="m-btn-primary" onClick={handleSearch} disabled={loading}>{loading ? '...' : '搜索'}</button>
      </div>
      <div className="m-filter-pills">
        <label className="m-pill">
           <input type="checkbox" checked={showSearchStatTrak} onChange={e => setShowSearchStatTrak(e.target.checked)} />
           <span>包含暗金</span>
        </label>
        <div className="m-pills-right">
           <button className="m-btn-text" onClick={() => {
              const visible = seriesResults.filter(r => showSearchStatTrak || !r.hash_name.includes('StatTrak™'));
              setSelectedHashNames(new Set(visible.map(r => r.hash_name)));
           }}>全选</button>
           <button className="m-btn-text" onClick={() => setSelectedHashNames(new Set())}>清空</button>
        </div>
      </div>
      
      <div className="m-list">
        {seriesResults.map(res => (
          <div key={res.hash_name} className={`m-result-card ${selectedHashNames.has(res.hash_name) ? 'selected' : ''}`} onClick={() => {
            const next = new Set(selectedHashNames);
            if(next.has(res.hash_name)) next.delete(res.hash_name);
            else next.add(res.hash_name);
            setSelectedHashNames(next);
          }}>
            <img src={res.image} alt="" />
            <div className="m-result-body">
              <div className="m-result-name">{res.name}</div>
              <div className="m-result-price">{res.price}</div>
            </div>
            <div className="m-result-check">{selectedHashNames.has(res.hash_name) ? '✅' : '○'}</div>
          </div>
        ))}
      </div>
      
      {selectedHashNames.size > 0 && (
        <div className="m-batch-action slideUp">
          <button className="m-btn-primary full-width" onClick={addBatchToTrack}>批量追踪 ({selectedHashNames.size})</button>
        </div>
      )}
    </div>
  );

  const renderRanking = () => (
    <div className="m-ranking-view">
      <div className="m-tabs-mini">
        <button className={!settings.showTopUp ? 'active' : ''} onClick={() => updateSettings({ showCashOut: true, showTopUp: false })}>换现金榜</button>
        <button className={settings.showTopUp ? 'active' : ''} onClick={() => updateSettings({ showCashOut: false, showTopUp: true })}>换余额榜</button>
      </div>
      <div className="m-ranking-list">
        {(settings.showTopUp ? topUpTop : cashOutTop).map((it, idx) => (
          <div key={it.hashName} className="m-rank-card">
            <div className="m-rank-num">{idx + 1}</div>
            <img className="m-rank-img" src={it.image} alt="" />
            <div className="m-rank-main">
              <div className="m-rank-name">{it.name || it.hashName}</div>
              <div className="m-rank-price">Steam: {it.steamPrices?.CNY} | C5: ¥{it.lastC5Price}</div>
            </div>
            <div className="m-rank-ratio-box">
              <div className="m-label">比例</div>
              <div className="m-val">{getRatio(it.steamPrices?.CNY, it.lastC5Price)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="m-settings-view">
      <div className="m-group-title">资产管理</div>
      <div className="m-card-glass">
        <div className="m-acc-row">
          <select className="m-select-dark" value={activeAccountId} onChange={e => setActiveAccountId(e.target.value)}>
            {steamAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="m-btn-icon" onClick={() => setIsAccountModalOpen(true)}>⚙️</button>
        </div>
        {activeAcc ? (
          <div className="m-acc-stats">
            <button className="m-stat m-btn-ghost" onClick={() => {
              if (!activeAcc) return;
              if (window._mobileDebug) window.alert('正在同步余额: ' + activeAcc.id);
              syncWealth(activeAcc.id);
            }}>
              <label>余额 (点击同步)</label>
              <strong>{activeAcc.balance || '¥ 0.00'}</strong>
            </button>
            <button className="m-stat m-btn-ghost" onClick={() => {
              if (!activeAcc) return;
              if (window._mobileDebug) window.alert('正在开启库存: ' + activeAcc.id);
              fetchInventory(activeAcc.id, activeAcc.name);
            }}>
              <label>库存总数</label>
              <strong className="m-link-text">{activeAcc.inventoryValue || '0 件'}</strong>
            </button>
          </div>
        ) : (
          <div className="m-empty-acc">请先选择或添加账号</div>
        )}
        <button className="m-btn-secondary" onClick={() => syncWealth(activeAccountId)} disabled={isSyncing}>
          {isSyncing ? '同步中...' : '🔄 立即同步余额/库存'}
        </button>
      </div>



      <div className="m-group-title">自动购买与过滤</div>
      <div className="m-card-glass">
        <label className="m-toggle-row">
          <span>开启自动购买</span>
          <input type="checkbox" checked={settings.autoBuyEnabled} onChange={e => updateSettings({ autoBuyEnabled: e.target.checked })} />
        </label>
        <div className="m-form-group">
          <label>触发比例 &gt;</label>
          <input type="number" step="0.01" className="m-input-dark" value={settings.autoBuyRatio} onChange={e => updateSettings({ autoBuyRatio: e.target.value })} />
        </div>
        <label className="m-toggle-row">
          <span>忽略同品类 (去重)</span>
          <input type="checkbox" checked={settings.autoBuyDedupeEnabled !== false} onChange={e => updateSettings({ autoBuyDedupeEnabled: e.target.checked })} />
        </label>
        <div className="m-form-group">
          <label>锁定时长 (小时)</label>
          <input type="number" className="m-input-dark" value={settings.autoBuyDedupeHours || 6} onChange={e => updateSettings({ autoBuyDedupeHours: e.target.value })} />
        </div>
      </div>

      <div className="m-group-title">Clash 代理 (Verge Rev)</div>
      <div className="m-card-glass">
        <label className="m-toggle-row">
          <span>自动换 IP (Steam 429)</span>
          <input type="checkbox" checked={settings.clashAutoRotate} onChange={e => updateSettings({ clashAutoRotate: e.target.checked })} />
        </label>
        <div className="m-form-group">
          <label>管道名称 (Pipe Name)</label>
          <input className="m-input-dark" value={settings.clashPipeName || 'xfltd-mihomo'} onChange={e => updateSettings({ clashPipeName: e.target.value })} />
        </div>
        <div className="m-form-group">
          <label>通信密钥 (Secret)</label>
          <input className="m-input-dark" type="password" value={settings.clashSecret || ''} onChange={e => updateSettings({ clashSecret: e.target.value })} />
        </div>
        <div className="m-form-group">
          <label>节点组 (Strategy Group)</label>
          <input className="m-input-dark" value={settings.clashGroup || ''} placeholder="例如: 🚀 节点选择" onChange={e => updateSettings({ clashGroup: e.target.value })} />
        </div>
        <div className="m-form-group">
          <label>代理端口</label>
          <input type="number" className="m-input-dark" value={settings.clashProxyPort || 7897} onChange={e => updateSettings({ clashProxyPort: e.target.value })} />
        </div>
        <button className="m-btn-secondary" onClick={async () => {
          try {
            const res = await api.post('/proxy/rotate');
            if (res.data.success) alert('✅ 换 IP 成功');
            else alert('❌ 换 IP 失败');
          } catch(e) { alert('❌ 连接服务器失败'); }
        }}>🎨 手动尝试换 IP (测试)</button>
      </div>

      <div className="m-group-title">其他</div>
      <button className="m-btn-sm full-width" onClick={() => setActiveModal('alertManager')}>🔔 管理全局预警列表</button>
    </div>
  );


  // ── Modals Selector ───────────────────────────────────────────────────────
  let modalContent = null;
  let modalTitle = '';
  if (activeModal === 'inventory') { modalTitle = viewingAccountName; modalContent = renderInventoryContent(); }
  if (activeModal === 'account') { modalTitle = '账号管理'; modalContent = renderAccountManager(); }
  if (activeModal === 'itemAlert') { modalTitle = '饰品预警'; modalContent = renderAlertContent(); }
  if (activeModal === 'sell') { modalTitle = '挂售饰品'; modalContent = renderSellDialogContent(); }
  if (activeModal === 'batchSell') { modalTitle = '批量上架配置'; modalContent = renderBatchSellContent(); }
  if (activeModal === 'alertManager') { 
    modalTitle = '全局预警管理'; 
    modalContent = (
      <div className="m-alert-manager">
        {trackedItems.filter(i => i.minAlert || i.maxAlert).map(item => (
          <div key={item.hashName} className="m-alert-item">
            <div className="m-alert-name">{item.name}</div>
            <div className="m-alert-vals">
              {item.minAlert && <span>Min: {item.minAlert}</span>}
              {item.maxAlert && <span>Max: {item.maxAlert}</span>}
            </div>
            <button className="m-icon-btn danger sm" onClick={() => handleSaveAlert(item, null, null, null, null)}>🗑️</button>
          </div>
        ))}
        {trackedItems.filter(i => i.minAlert || i.maxAlert).length === 0 && <div className="m-empty">暂无预警项</div>}
      </div>
    );
  }

  if (requiresLogin) {
    return (
      <div className="m-login-overlay">
        <div className="m-login-box glass-effect">
          <div className="m-login-icon">🔐</div>
          <h2>Steam 搬砖助手</h2>
          <p>请输入管理员密码</p>
          <input type="password" placeholder="管理员密码" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleLogin()} className="m-input" />
          <button className="m-btn-primary" onClick={handleLogin}>登录</button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-app">
      <header className="m-header">
        <div className="m-header-left">
           <span className="m-header-title" onClick={() => {
              window._mobileDebug = !window._mobileDebug;
              window.alert('调试模式: ' + (window._mobileDebug ? '开启' : '关闭'));
            }}>搬砖助手 Pro</span>
           {isSyncing && <div className="m-header-sync-dot"></div>}
        </div>
        <div className="m-header-right">
           <span className="m-header-info">{trackedItems.length} 项</span>
        </div>
      </header>

      <main className="m-main custom-scrollbar">
        {activeTab === 'tracked' && renderTracked()}
        {activeTab === 'search' && renderSearch()}
        {activeTab === 'ranking' && renderRanking()}
        {activeTab === 'settings' && renderSettings()}
      </main>

      <nav className="m-nav">
        {[
          { key: 'tracked', icon: '📊', label: '追踪' },
          { key: 'search', icon: '🔍', label: '搜索' },
          { key: 'ranking', icon: '🏆', label: '排行' },
          { key: 'settings', icon: '⚙️', label: '管理' },
        ].map(t => (
          <button key={t.key} className={`m-nav-item ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
            <span className="m-nav-icon">{t.icon}</span>
            <span className="m-nav-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* Shared Modal */}
      {activeModal && renderModal(modalTitle, modalContent)}

      {/* Notifications */}
      <div className="m-toasts">
        {(notifications || []).map(n => (
          <div key={n.id} className={`m-toast ${n.type} ${n.removing ? 'removing' : ''}`} onClick={() => removeNotification(n.id)}>
             {n.image && <img src={n.image} className="m-toast-img" />}
             <div className="m-toast-content">
                <div className="m-toast-title">{n.title}</div>
                <div className="m-toast-msg">{n.message}</div>
                {n.price && <div className="m-toast-price">{n.price}</div>}
             </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MobileView;
