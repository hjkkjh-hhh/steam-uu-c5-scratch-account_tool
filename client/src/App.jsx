import { useState, useEffect, useRef, useMemo } from 'react';
import api from './api';
import './App.css';
import MobileView from './MobileView';
import RedLetterScanner from './RedLetterScanner';
import InventoryTransferModal from './InventoryTransferModal';
import TradeConfirmModal from './TradeConfirmModal';

// Reusable Custom Select Component
const CustomSelect = ({ value, options, onChange, labelPrefix, className = "" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(o => String(o.value) === String(value));

  return (
    <div className={`custom-select-container ${className}`} ref={containerRef}>
      <div
        className={`custom-select-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {labelPrefix && <span className="label-prefix">{labelPrefix}</span>}
        <span className="selected-value">{selectedOption?.label || value}</span>
        <span className="custom-select-arrow"></span>
      </div>
      {isOpen && (
        <div className="custom-options-list">
          {options.map(opt => (
            <div
              key={opt.value}
              className={`custom-option ${String(opt.value) === String(value) ? 'selected' : ''}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function App() {
  const [item, setItem] = useState('');
  const [isMobile, setIsMobile] = useState(() => {
    const ua = navigator.userAgent || '';
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua);
    return isMobileUA || window.innerWidth <= 768;
  });
  const [activeTab, setActiveTab] = useState('tracked'); // 'tracked', 'search', 'settings' for mobile
  const [seriesResults, setSeriesResults] = useState([]);
  const [selectedHashNames, setSelectedHashNames] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [trackedItems, setTrackedItems] = useState([]);
  const [selectedInterval, setSelectedInterval] = useState(30); // Default 30 min
  const [settings, setSettings] = useState({
    activeCurrencies: ['CNY', 'USD'],
    showCashOut: true,
    showTopUp: true,
    dingTalkWebhook: '',
    dingTalkSecret: '',
    rankingMinPrice: '',
    rankingMaxPrice: '',
    showTrackedTopUp: false,
    pushRankingCashThreshold: 0.87,
    pushRankingTopUpThreshold: 0.65,
    showStatTrak: true,
  });
  const [dingTalkWebhookInput, setDingTalkWebhookInput] = useState('');
  const [dingTalkSecretInput, setDingTalkSecretInput] = useState('');
  const [steamCookieInput, setSteamCookieInput] = useState('');
  const [dingTalkSaving, setDingTalkSaving] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // Auth state
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');

  useEffect(() => {
    // 1. Initial Auth Restoration Attempt
    const storedPass = localStorage.getItem('adminPassword');
    if (storedPass) {
      console.log('[AUTH] Restoring session from localStorage...');
      api.defaults.headers.common['Authorization'] = `Bearer ${storedPass}`;
      setPasswordInput(storedPass); // Keep UI in sync
      setRequiresLogin(false);
    } else {
      setRequiresLogin(true); // Ensure login UI shows if no password
    }

    // 2. Response interceptor to handle authentication failures globally
    const resInterceptor = api.interceptors.response.use(
      response => response,
      error => {
        if (error.response && error.response.status === 401) {
          console.warn('[AUTH] 401 Unauthorized detected. Prompting for login.');
          localStorage.removeItem('adminPassword'); // Clear potentially invalid/stale password
          setRequiresLogin(true);
        }
        return Promise.reject(error);
      }
    );

    // Initial Fetch (Implicitly waits for header if needed)
    if (storedPass || !requiresLogin) {
      fetchAccounts();
      fetchTracked();
      fetchSettings();
      fetchInventorySummary();
      fetchGroups();
    }

    return () => {
      api.interceptors.response.eject(resInterceptor);
    };
  }, []);

  const [cashOutWidth, setCashOutWidth] = useState(() => parseInt(localStorage.getItem('cashOutWidth')) || 250);
  const [topUpWidth, setTopUpWidth] = useState(() => parseInt(localStorage.getItem('topUpWidth')) || 250);

  const startResizing = (side) => (e) => {
    e.preventDefault();
    const isLeft = side === 'left';
    const startX = e.clientX;
    const startWidth = isLeft ? cashOutWidth : topUpWidth;

    const onMouseMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = isLeft ? startWidth + delta : startWidth - delta;
      const constrainedWidth = Math.min(Math.max(nextWidth, 180), 600);
      if (isLeft) {
        setCashOutWidth(constrainedWidth);
        localStorage.setItem('cashOutWidth', constrainedWidth);
      } else {
        setTopUpWidth(constrainedWidth);
        localStorage.setItem('topUpWidth', constrainedWidth);
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
  };

  const handleLogin = async () => {
    try {
      await api.post('auth/login', { password: passwordInput });
      localStorage.setItem('adminPassword', passwordInput);
      api.defaults.headers.common['Authorization'] = `Bearer ${passwordInput}`;
      setRequiresLogin(false);
      fetchAccounts();
      fetchTracked();
      fetchSettings();
      fetchInventorySummary();
    } catch (e) {
      alert(e.response?.data?.error || '密码错误');
    }
  };

  // Leaderboard filters (Local UI only, for search results)
  const [showSearchStatTrak, setShowSearchStatTrak] = useState(true);
  const [searchMinPrice, setSearchMinPrice] = useState('');
  const [searchMaxPrice, setSearchMaxPrice] = useState('');

  // Steam Account Management
  const [steamAccounts, setSteamAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState(() => {
    return localStorage.getItem('activeAccountId') || '1';
  });
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false); // General sync loading state
  const [isSyncingPersonas, setIsSyncingPersonas] = useState(false); // Persona sync state

  // Inventory Modal State
  const [isInventoryModalOpen, setIsInventoryModalOpen] = useState(false);
  const [inventoryValue, setInventoryValue] = useState('N/A');
  const [inventoryData, setInventoryData] = useState(null);
  const [inventorySummary, setInventorySummary] = useState({}); // hashName -> totalCount
  const [inventoryLoading, setInventoryLoading] = useState(false);

  // --- NEW: Inventory Caching State (Now DB-backed) ---
  const [inventoryCache, setInventoryCache] = useState({});
  const [isAlertModalOpen, setIsAlertModalOpen] = useState(false);
  const [viewingAccountName, setViewingAccountName] = useState('');
  const [viewingAccountId, setViewingAccountId] = useState(null);
  // Sell dialog state
  const [sellDialog, setSellDialog] = useState(null); // { item, assetids: [] }
  const [sellSellerPrice, setSellSellerPrice] = useState('');
  const [isListingsModalOpen, setIsListingsModalOpen] = useState(false);
  const [activeListings, setActiveListings] = useState([]);
  const [isScannerModalOpen, setIsScannerModalOpen] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [groupBanModal, setGroupBanModal] = useState(null); // { groupId, groupName, loading, data, error }
  const [listingsLoading, setListingsLoading] = useState(false);
  const [selectedListings, setSelectedListings] = useState([]); // New state for batch removal
  const [sellBuyerPrice, setSellBuyerPrice] = useState('');
  const [sellQuantity, setSellQuantity] = useState(1);
  const [isSelling, setIsSelling] = useState(false);
  const [marketPriceInfo, setMarketPriceInfo] = useState(null); // { lowest_price, loading }
  const [notifications, setNotifications] = useState([]);
  const [isAlertManagerOpen, setIsAlertManagerOpen] = useState(false);
  const [alertItem, setAlertItem] = useState(null);
  const [isBatchSellModalOpen, setIsBatchSellModalOpen] = useState(false);

  // Main Page Tab
  const [mainPageTab, setMainPageTab] = useState('tracking');

  // C5 Account Management State
  const [c5Balance, setC5Balance] = useState(null);
  const [c5BalanceLoading, setC5BalanceLoading] = useState(false);
  const [selectedC5AccountId, setSelectedC5AccountId] = useState(null);
  const [c5AccountSubTab, setC5AccountSubTab] = useState('inventory');
  const [c5Inventory, setC5Inventory] = useState([]);
  const [c5InventoryLoading, setC5InventoryLoading] = useState(false);
  const [c5Listings, setC5Listings] = useState([]);
  const [c5ListingsLoading, setC5ListingsLoading] = useState(false);
  const [editingTradeUrlId, setEditingTradeUrlId] = useState(null);
  const [tradeUrlInput, setTradeUrlInput] = useState('');
  const [fetchingTradeUrlId, setFetchingTradeUrlId] = useState(null);
  const [c5BuyHashName, setC5BuyHashName] = useState('');
  const [c5BuyAccountId, setC5BuyAccountId] = useState('');
  const [c5BuyLoading, setC5BuyLoading] = useState(false);
  const [c5ModifyDialog, setC5ModifyDialog] = useState(null);
  const [c5ModifyPriceInput, setC5ModifyPriceInput] = useState('');
  const [c5ListingToken, setC5ListingToken] = useState(null);
  const [c5ListingItemObj, setC5ListingItemObj] = useState(null);
  const [c5ListPriceInput, setC5ListPriceInput] = useState('');
  const [c5ListQuantity, setC5ListQuantity] = useState(1);
  const [c5ModifyQuantity, setC5ModifyQuantity] = useState(1);
  // C5 inventory enhanced state
  const [c5StackMode, setC5StackMode] = useState(true);
  const [c5InventoryViewMode, setC5InventoryViewMode] = useState('single'); // 'single' | 'all'
  const [c5AllInventory, setC5AllInventory] = useState([]);
  const [c5AllInventoryLoading, setC5AllInventoryLoading] = useState(false);
  const [c5SelectedTokens, setC5SelectedTokens] = useState(new Set());
  const [c5BatchListPrice, setC5BatchListPrice] = useState('');
  const [c5BatchLoading, setC5BatchLoading] = useState(false);
  const [c5InventorySearch, setC5InventorySearch] = useState('');
  const [c5BatchModifyPriceInput, setC5BatchModifyPriceInput] = useState('');
  const [c5BatchModifyLoading, setC5BatchModifyLoading] = useState(false);
  // C5 buy panel state
  const [c5BuyResults, setC5BuyResults] = useState(null);
  // C5 market prices & valuation
  const [c5MarketPrices, setC5MarketPrices] = useState({}); // marketHashName -> price
  const [isFetchingC5Prices, setIsFetchingC5Prices] = useState(false);
  const [c5TotalValue, setC5TotalValue] = useState(0);
  const [c5TotalCount, setC5TotalCount] = useState(0);
  // C5 inventory filters
  const [c5SortOrder, setC5SortOrder] = useState('none');         // 'none' | 'asc' | 'desc'
  const [c5PriceMin, setC5PriceMin] = useState('');
  const [c5PriceMax, setC5PriceMax] = useState('');
  const [c5HideGraffiti, setC5HideGraffiti] = useState(false);
  const [c5HideNonTradable, setC5HideNonTradable] = useState(true); // 默认隐藏状态2,3
  const [c5StatusView, setC5StatusView] = useState('all'); // 'all' | 'sellable' | 'listed'

  // C5 Matrix & Batch Import State
  const [isC5MatrixOpen, setIsC5MatrixOpen] = useState(false);
  const [c5BoundAccounts, setC5BoundAccounts] = useState([]);
  const [c5BoundLoading, setC5BoundLoading] = useState(false);
  const [isC5ImportModalOpen, setIsC5ImportModalOpen] = useState(false);
  const [c5ImportResults, setC5ImportResults] = useState(null);
  const [isC5Importing, setIsC5Importing] = useState(false);
  const [importLogs, setImportLogs] = useState([]);
  // C5 Batch Bind Modal state
  const [isC5BatchBindOpen, setIsC5BatchBindOpen] = useState(false);
  const [c5BatchBindSelected, setC5BatchBindSelected] = useState(new Set());
  const [c5BatchBindMerchantId, setC5BatchBindMerchantId] = useState('');
  const [c5BatchBindPhone, setC5BatchBindPhone] = useState('');
  const [c5BatchBindResults, setC5BatchBindResults] = useState(null);
  const [isC5BatchBindLoading, setIsC5BatchBindLoading] = useState(false);

  // Multi-Merchant State
  const [merchants, setMerchants] = useState([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState(null);
  const [isMerchantManagerOpen, setIsMerchantManagerOpen] = useState(false);
  const [merchantEditForm, setMerchantEditForm] = useState(null); // { id, name, appKey, isDefault }

  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [isGroupManagerOpen, setIsGroupManagerOpen] = useState(false);
  const [groupEditForm, setGroupEditForm] = useState(null);
  const [groupSyncProgress, setGroupSyncProgress] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set(['__ungrouped__']));
  const [refreshingTokenIds, setRefreshingTokenIds] = useState(new Set());
  const [totpCodes, setTotpCodes] = useState(new Map()); // accId -> { code, secondsRemaining, loading }
  // Batch Password Import
  const [isBatchPasswordModalOpen, setIsBatchPasswordModalOpen] = useState(false);

  const fetchTotp = async (accId) => {
    try {
      const res = await api.get(`accounts/${accId}/totp`);
      if (res.data.success) {
        setTotpCodes(prev => {
          if (!prev.has(accId)) return prev; // User closed it while fetching
          const n = new Map(prev);
          n.set(accId, {
            code: res.data.code,
            secondsRemaining: res.data.secondsRemaining,
            loading: false
          });
          return n;
        });
      } else {
        const errMsg = res.data.error || '获取失败';
        setTotpCodes(prev => {
          if (!prev.has(accId)) return prev;
          const n = new Map(prev);
          n.set(accId, { code: errMsg, secondsRemaining: 0, loading: false, isError: true });
          return n;
        });
        // Error messages persist for 4s then we try again if still active? No, just keep error.
      }
    } catch (err) {
      // Keep loading or set error
    }
  };

  // Global TOTP Countdown Timer & Auto-Refresh
  useEffect(() => {
    const timer = setInterval(() => {
      setTotpCodes(prev => {
        if (prev.size === 0) return prev;
        let hasChanges = false;
        const next = new Map(prev);
        for (const [id, data] of next.entries()) {
          if (data.loading || data.isError) continue;
          if (data.secondsRemaining > 0) {
            next.set(id, { ...data, secondsRemaining: data.secondsRemaining - 1 });
            hasChanges = true;
          } else {
            // Auto-refresh when hits 0
            next.set(id, { ...data, loading: true });
            fetchTotp(id);
            hasChanges = true;
          }
        }
        return hasChanges ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Track last alerted price to prevent spamming the same price on every pull
  const lastAlertedRef = useRef(new Map()); // hashName -> lastPrice

  const addNotification = (notif) => {
    const id = Date.now();
    const timestamp = new Date().toLocaleTimeString();
    setNotifications(prev => [...prev, { ...notif, id, timestamp }]);
    // Use a small audio alert if possible, or just visual
    if (!notif.persistent) {
      setTimeout(() => removeNotification(id), 10000); // Auto-remove after 10s
    }
  };

  const removeNotification = (id) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, removing: true } : n));
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 400); // Match CSS animation time
  };

  const fetchAccounts = async () => {
    try {
      const res = await api.get('accounts');
      setSteamAccounts(res.data);
    } catch (e) {
      console.error('Failed to fetch accounts');
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    localStorage.setItem('activeAccountId', activeAccountId);
  }, [activeAccountId]);
  const [sortConfig, setSortConfig] = useState({ key: 'ratio', direction: 'asc' }); // Sort by ratio asc by default

  useEffect(() => {
    fetchTracked();
    fetchSettings();
    fetchInventorySummary();
    fetchMerchants();

    // Auto-refresh tracked list every 30 seconds to pick up backend updates
    const timer = setInterval(() => {
      fetchTracked();
      fetchInventorySummary(); // Refresh inventory summary as well
    }, 30000);

    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const fetchInventorySummary = async () => {
    try {
      const res = await api.get('inventory/summary');
      setInventorySummary(res.data);
    } catch (e) {
      console.error('Failed to fetch inventory summary');
    }
  };
  const fetchSettings = async () => {
    try {
      const res = await api.get('settings');
      const data = res.data;
      setSettings(data);
      setDingTalkWebhookInput(data.dingTalkWebhook || '');
      setDingTalkSecretInput(data.dingTalkSecret || '');
      setSteamCookieInput(data.steamCookie || '');
    } catch (e) {
      console.error('Failed to fetch settings');
    }
  };

  const updateSettings = async (updates) => {
    // Optimistic local update
    setSettings(prev => ({ ...prev, ...updates }));

    try {
      const res = await api.post('settings', updates);
      setSettings(res.data.settings);
    } catch (e) {
      console.error('Failed to update settings');
    }
  };

  // Currency toggle logic removed as system is now CNY-only

  const saveDingTalkSettings = async () => {
    setDingTalkSaving(true);
    try {
      await updateSettings({
        dingTalkWebhook: dingTalkWebhookInput.trim(),
        dingTalkSecret: dingTalkSecretInput.trim(),
        steamCookie: steamCookieInput.trim()
      });
    } finally {
      setDingTalkSaving(false);
    }
  };

  const fetchC5BoundAccounts = async (mId) => {
    const targetId = mId || selectedMerchantId;
    setC5BoundLoading(true);
    try {
      const res = await api.get('c5/steam-info', { params: { merchantId: targetId } });
      if (res.data.success) {
        setC5BoundAccounts(res.data.data.steamList || []);
      }
    } catch (e) {
      console.error('Failed to fetch C5 bound accounts', e.message);
    } finally {
      setC5BoundLoading(false);
    }
  };

  const handleSyncToLocal = async (c5Acc) => {
    try {
      const res = await api.post('accounts/sync-cloud', {
        steamId: c5Acc.steamId,
        personaName: c5Acc.personaName,
        tradeUrl: c5Acc.tradeUrl,
        merchantId: selectedMerchantId
      });
      if (res.data.success) {
        addNotification({ title: '同步成功', message: `账号 ${c5Acc.personaName || c5Acc.steamId} 已同步到本地`, type: 'info' });
        fetchAccounts(); // Refresh local list
      }
    } catch (e) {
      addNotification({ title: '同步失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  const fetchMerchants = async () => {
    try {
      const res = await api.get('c5/merchants');
      if (res.data.success) {
        setMerchants(res.data.merchants);
        // Set default selected if not set
        const def = res.data.merchants.find(m => m.isDefault) || res.data.merchants[0];
        if (def && !selectedMerchantId) setSelectedMerchantId(def.id);
      }
    } catch (e) {
      console.error('Failed to fetch merchants', e.message);
    }
  };

  const fetchGroups = async () => {
    try {
      const res = await api.get('groups');
      if (res.data.success) setGroups(res.data.groups);
    } catch (e) {
      console.error('Failed to fetch groups', e.message);
    }
  };

  const handleSaveGroup = async (data) => {
    try {
      const res = await api.post('groups', data);
      if (res.data.success) {
        setGroups(res.data.groups);
        setGroupEditForm(null);
        addNotification({ title: `分组已保存`, message: data.name, type: 'info' });
      }
    } catch (e) {
      addNotification({ title: '保存失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  const handleDeleteGroup = async (id) => {
    if (!window.confirm('确定删除此分组？分组内账号将解除关联，不会被删除。')) return;
    try {
      const res = await api.delete(`groups/${id}`);
      if (res.data.success) {
        setGroups(res.data.groups);
        if (selectedGroupId === id) setSelectedGroupId(null);
        fetchAccounts();
        addNotification({ title: '分组已删除', type: 'info' });
      }
    } catch (e) {
      addNotification({ title: '删除失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  const handleAssignGroup = async (accountId, groupId) => {
    try {
      await api.put(`accounts/${accountId}/group`, { groupId });

      // Optimistically update local accounts state
      setSteamAccounts(prev => prev.map(a => a.id === accountId ? { ...a, groupId: groupId || null } : a));
      fetchGroups(); // Refresh counts
    } catch (e) {
      addNotification({ title: '分组分配失败', message: e.message, type: 'error' });
    }
  };

  // 获取交易链接并复制到剪贴板（已有则直接复制，没有则先通过 maFile 自动获取）
  const handleCopyOrFetchTradeUrl = async (acc) => {
    if (acc.tradeUrl) {
      try {
        await navigator.clipboard.writeText(acc.tradeUrl);
        addNotification({ title: '已复制', message: `交易链接已复制到剪贴板`, type: 'success' });
      } catch (e) {
        addNotification({ title: '复制失败', message: e.message, type: 'error' });
      }
      return;
    }
    // 没有交易链接 → 通过 maFile RefreshToken 自动获取
    if (!acc.mafileContent && !acc.refreshToken) {
      addNotification({ title: '无法获取', message: '该账号没有 maFile，无法自动获取交易链接', type: 'warning' });
      return;
    }
    setFetchingTradeUrlId(acc.id);
    // 清除该账号之前的错误
    setSteamAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, tradeUrlError: null } : a));

    try {
      const res = await api.post(`accounts/${acc.id}/fetch-trade-url`);
      if (res.data.success && res.data.tradeUrl) {
        const url = res.data.tradeUrl;
        setSteamAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, tradeUrl: url, tradeUrlError: null } : a));
        // 剪贴板写入单独处理，失败时不影响成功提示
        try {
          await navigator.clipboard.writeText(url);
          addNotification({ title: '成功', message: `交易链接已获取并复制到剪贴板`, type: 'success' });
        } catch {
          addNotification({ title: '成功', message: `交易链接已获取（剪贴板不可用，请手动复制）`, type: 'success' });
        }
      } else {
        const errMsg = res.data.error || '未知错误';
        setSteamAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, tradeUrlError: errMsg } : a));
        addNotification({ title: '获取失败', message: errMsg, type: 'error' });
      }
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message;
      setSteamAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, tradeUrlError: errMsg } : a));
      addNotification({ title: '获取失败', message: errMsg, type: 'error' });
    } finally {
      setFetchingTradeUrlId(null);
    }
  };

  // Mixed inventory fetch: use C5 API for accounts bound to C5, Steam public API for others
  // 实时刷新单个账号的 Steam Web Session Cookie
  const fetchBatchC5Prices = async (items) => {
    if (!items || items.length === 0) return;
    setIsFetchingC5Prices(true);
    try {
      const hashNames = [...new Set(items.map(i => i.marketHashName || i.name).filter(Boolean))];
      const res = await api.post('c5/prices/batch', { hashNames, appid: 730 });
      if (res.data.success && res.data.data) {
        const batchData = res.data.data;
        const newPrices = { ...c5MarketPrices };

        // Helper to update prices in an inventory array
        const updateArrayPrices = (arr) => {
          return arr.map(item => {
            const name = item.marketHashName || item.name;
            const p = batchData[name];
            if (p !== undefined) {
              const val = (p && typeof p === 'object' && p.sellPrice !== undefined) ? p.sellPrice : p;
              if (val > 0) {
                return { ...item, price: val };
              }
            }
            return item;
          });
        };

        // 1. Update local price mapping state
        Object.entries(batchData).forEach(([name, p]) => {
          if (p && typeof p === 'object' && p.sellPrice !== undefined) {
            newPrices[name] = p.sellPrice;
          } else {
            newPrices[name] = p;
          }
        });
        setC5MarketPrices(newPrices);

        // 2. Update the actual inventory items in state
        const updatedInventory = updateArrayPrices(c5Inventory);
        const updatedAllInventory = updateArrayPrices(c5AllInventory);

        setC5Inventory(updatedInventory);
        setC5AllInventory(updatedAllInventory);

        // 3. Persist the updated inventory to DB for future refreshes/sorting
        if (selectedGroupId) {
          const itemsToSave = c5InventoryViewMode === 'all' ? updatedAllInventory : updatedInventory;
          try {
            await api.post('/inventory/cache', {
              groupId: selectedGroupId,
              items: itemsToSave
            });
            console.log('[C5 Price Persistence] Successfully saved updated prices to DB cache.');
          } catch (cacheErr) {
            console.error('[C5 Price Persistence] Failed to save updated inventory to DB:', cacheErr);
          }
        }

        addNotification({
          title: '✅ 价格更新',
          message: `已成功获取并保存 ${Object.keys(batchData).length} 件饰品的 C5 市场底价`,
          type: 'success'
        });
      }
    } catch (e) {
      console.error('[C5 Batch Price] Failed:', e);
      addNotification({ title: '查价失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setIsFetchingC5Prices(false);
    }
  };

  const handleRefreshToken = async (acc, e) => {
    e.stopPropagation();
    if (!acc.refreshToken) {
      addNotification({ title: '无法刷新', message: `${acc.name} 没有 RefreshToken，请重新导入 maFile`, type: 'warning' });
      return;
    }
    setRefreshingTokenIds(prev => new Set([...prev, acc.id]));
    try {
      const res = await api.post(`accounts/${acc.id}/refresh-token`);
      if (res.data.success) {
        addNotification({ title: '✅ 令牌已刷新', message: `${acc.name} Cookie 已更新`, type: 'success' });
      } else {
        addNotification({ title: '刷新失败', message: res.data.error, type: 'error' });
      }
    } catch (err) {
      addNotification({ title: '刷新失败', message: err.response?.data?.error || err.message, type: 'error' });
    } finally {
      setRefreshingTokenIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  // 重新登录：用密码+maFile TOTP 获取新 RefreshToken
  const [reloginDialog, setReloginDialog] = useState(null); // { acc, password, loading, error }
  const [reloginIds, setReloginIds] = useState(new Set());

  const handleRelogin = async () => {
    if (!reloginDialog) return;
    const { acc, password } = reloginDialog;
    setReloginDialog(prev => ({ ...prev, loading: true, error: null }));
    setReloginIds(prev => new Set([...prev, acc.id]));
    try {
      const res = await api.post(`accounts/${acc.id}/relogin`, { password });
      if (res.data.success) {
        // 保存密码到本地
        await api.post(`accounts/${acc.id}/save-password`, { password }).catch(() => { });
        addNotification({ title: '✅ 重新登录成功', message: res.data.message, type: 'success' });
        setReloginDialog(null);
        fetchAccounts();
      } else {
        setReloginDialog(prev => ({ ...prev, loading: false, error: res.data.error }));
      }
    } catch (err) {
      setReloginDialog(prev => ({ ...prev, loading: false, error: err.response?.data?.error || err.message }));
    } finally {
      setReloginIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
    }
  };

  const fetchGroupInventory = async (groupId, force = false) => {
    const cacheKey = groupId ? String(groupId) : 'all';

    // ⚡ Case 1: Load from DB Cache (default behavior when switching tabs/groups)
    if (!force) {
      setC5AllInventoryLoading(true);
      try {
        const res = await api.get('inventory/cache', { params: { groupId: groupId || 'all' } });
        if (res.data.success) {
          const items = res.data.items || [];
          setC5AllInventory(items);
          setInventoryCache(prev => ({
            ...prev,
            [cacheKey]: { items, timestamp: new Date(res.data.updatedAt).getTime() }
          }));
        } else {
          // No cache in DB — show empty
          setC5AllInventory([]);
          setInventoryCache(prev => {
            const nc = { ...prev };
            delete nc[cacheKey];
            return nc;
          });
        }
      } catch (e) {
        console.error('[InventoryCache] Failed to fetch from DB:', e.message);
        setC5AllInventory([]);
      } finally {
        setC5AllInventoryLoading(false);
      }
      return;
    }

    // ⚡ Case 2: Full Network Sync (triggered by "Sync All" button)
    setC5AllInventoryLoading(true);
    setC5AllInventory([]);
    const targetAccounts = groupId
      ? steamAccounts.filter(a => a.steamId64 && String(a.groupId) === String(groupId))
      : steamAccounts.filter(a => a.steamId64);

    const combined = [];
    setGroupSyncProgress({ current: 0, total: targetAccounts.length });
    let aborted = false;

    const queue = [...targetAccounts];
    let completedCount = 0;

    // 现在已启用 Webshare 动态住宅 IP，可以将并发提高到 10 且大幅缩短请求间隙
    const CONCURRENCY = 10;

    const createWorker = async (startDelay) => {
      if (startDelay > 0) await new Promise(r => setTimeout(r, startDelay));

      while (queue.length > 0 && !aborted) {
        const acc = queue.shift();
        if (!acc) continue;

        const t0 = Date.now();
        try {
          let fetched = false;

          // Step 1: Try C5 API if the account has a merchant ID
          if (acc.c5MerchantId) {
            try {
              const res = await api.get(`c5/inventory/${acc.steamId64}`);
              if (res.data.success) {
                const items = Array.isArray(res.data.data)
                  ? res.data.data
                  : (res.data.data?.items || []);
                if (items.length > 0) {
                  const toPush = items.map(item => ({
                    ...item,
                    _accountName: acc.name,
                    _accountId: acc.id,
                    _source: 'c5'
                  }));
                  combined.push(...toPush);
                  fetched = true;
                }
              }
            } catch (c5Err) {
              console.warn(`[GroupInventory] ${acc.name} C5接口失败 (${c5Err.message})，将尝试 Steam 公开库存`);
            }
          }

          // Step 2: Fallback to Steam public inventory API (with persistent retry)
          if (!fetched && !aborted) {
            const result = await fetchSteamInventoryWithRetry(acc.steamId64, acc.name);
            if (result.rateLimited) {
              addNotification({ title: '⛔ 同步中断', message: `Steam 连续 3 次 429 限频，已停止同步`, type: 'error' });
              aborted = true;
            } else if (result.success) {
              const toPush = (result.items || []).map(item => ({
                ...item,
                _accountName: acc.name,
                _accountId: acc.id,
                _source: 'steam'
              }));
              combined.push(...toPush);
            } else if (result.hiddenByNewItemRule) {
              console.warn(`[GroupInventory] ${acc.name} Steam 10天新物品隐藏规则，库存暂时不可见`);
            } else if (result.private) {
              console.warn(`[GroupInventory] ${acc.name} Steam 库存为私密，已跳过`);
            }
          }
        } catch (e) {
          if (e.response?.data?.rateLimited) {
            addNotification({ title: '⛔ 同步中断', message: `Steam 连续 3 次 429 限频，已停止同步`, type: 'error' });
            aborted = true;
          } else {
            console.error(`[GroupInventory] ${acc.name} 库存获取失败:`, e.message);
          }
        }

        if (!aborted) {
          completedCount++;
          setGroupSyncProgress({ current: completedCount, total: targetAccounts.length });
          setC5AllInventory([...combined]);
          // 缩短间隔：由于 Webshare 自动轮换 IP，每次请求周期不少于 500ms 即可
          const elapsed = Date.now() - t0;
          const gap = Math.max(0, 500 - elapsed) + Math.random() * 200;
          if (gap > 0) await new Promise(r => setTimeout(r, gap));
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, targetAccounts.length) },
      (_, i) => createWorker(i * 500) // 错赋 500ms 启动
    );
    await Promise.all(workers);

    // Cache Update Logic
    if (!aborted) {
      setC5AllInventory(combined);
      setInventoryCache(prev => {
        const newCache = { ...prev, [cacheKey]: { items: combined, timestamp: Date.now() } };
        localStorage.setItem('steamInventoryCache', JSON.stringify(newCache));
        return newCache;
      });

      // ⚡ New: Persist to DB cache via Server API
      try {
        await api.post('inventory/cache', { groupId: groupId || 'all', items: combined });
        console.log(`[InventoryCache] Successfully persisted Group ${groupId || 'all'} to DB.`);
      } catch (e) {
        console.error('[InventoryCache] Failed to persist to DB:', e.response?.data?.error || e.message);
      }
    }
    setC5AllInventoryLoading(false);
    setGroupSyncProgress(null);
  };



  const handleC5Import = async (files) => {
    if (!files || files.length === 0) return;

    setIsC5Importing(true);
    setC5ImportResults(null);
    const initialLogs = Array.from(files).map(f => ({ name: f.name, status: 'pending', detail: '等待处理...' }));
    setImportLogs(initialLogs);

    try {
      const maFiles = [];
      for (const file of files) {
        const text = await file.text();
        maFiles.push({ name: file.name, content: text });
      }

      const token = localStorage.getItem('adminPassword');
      const response = await fetch('/api/accounts/import-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify({ maFiles }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const event of events) {
          const line = event.startsWith('data: ') ? event.slice(6) : event;
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'progress') {
              setImportLogs(prev => prev.map(l =>
                l.name === msg.name ? { ...l, status: 'processing', detail: msg.detail } : l
              ));
            } else if (msg.type === 'file_done') {
              setImportLogs(prev => prev.map(l =>
                l.name === msg.name
                  ? { ...l, status: msg.success ? 'done' : (msg.skipped ? 'skipped' : 'error'), detail: '', result: msg }
                  : l
              ));
            } else if (msg.type === 'done') {
              setC5ImportResults(msg.results);
              fetchAccounts();
              fetchGroups();
            }
          } catch (_) { }
        }
      }
    } catch (e) {
      addNotification({ title: '批量导入失败', message: e.message, type: 'error' });
    } finally {
      setIsC5Importing(false);
    }
  };

  const handleC5BatchBind = async () => {
    if (c5BatchBindSelected.size === 0) return addNotification({ title: '请先选择要绑定的账号', type: 'error' });
    if (!c5BatchBindMerchantId) return addNotification({ title: '请先选择目标 C5 商户', type: 'error' });
    if (!c5BatchBindPhone.trim()) return addNotification({ title: '请输入 C5 账号绑定的手机号', type: 'error' });
    setIsC5BatchBindLoading(true);
    setC5BatchBindResults(null);
    try {
      const res = await api.post('c5/batch-bind', {
        accountIds: Array.from(c5BatchBindSelected),
        merchantId: c5BatchBindMerchantId,
        phone: c5BatchBindPhone.trim(),
        areaCode: 86
      });
      setC5BatchBindResults(res.data.results);
      setSteamAccounts(prev => prev.map(a => {
        if (c5BatchBindSelected.has(String(a.id)) && res.data.results.find(r => r.id === a.id && r.success)) {
          return { ...a, c5MerchantId: c5BatchBindMerchantId };
        }
        return a;
      }));
      const ok = res.data.successCount;
      const total = res.data.totalCount;
      addNotification({ title: `C5 批量绑定完成`, message: `成功 ${ok}/${total} 个账号`, type: ok === total ? 'success' : 'warning' });
    } catch (e) {
      addNotification({ title: 'C5 批量绑定失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setIsC5BatchBindLoading(false);
    }
  };

  const handleSaveMerchant = async (data) => {
    try {
      await api.post('c5/merchants', data);
      addNotification({ title: '商户保存成功', type: 'info' });
      fetchMerchants();
      setMerchantEditForm(null);
    } catch (e) {
      addNotification({ title: '商户保存失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  const handleDeleteMerchant = async (id) => {
    if (!window.confirm('确定删除该商户？关联的 Steam 账号将解除商户绑定（不会删除 Steam 账号数据）。')) return;
    try {
      await api.delete(`c5/merchants/${id}`);
      addNotification({ title: '商户已删除', type: 'info' });
      fetchMerchants();
    } catch (e) {
      addNotification({ title: '删除失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };
  const testDingTalk = async () => {
    try {
      const res = await api.get('test-dingtalk');
      const data = res.data;
      if (res.status === 200) {
        alert('✅ ' + data.message);
      } else {
        alert('❌ ' + (data.error || '发送失败'));
      }
    } catch (e) {
      alert('❌ 网络错误或权限不足，请确认服务器已运行');
    }
  };

  const fetchTracked = async () => {
    try {
      const res = await api.get('tracked');
      const data = res.data;

      // Alert checking logic
      data.forEach(item => {
        if (!item.lastC5Price) return;
        const currentPrice = parseFloat(item.lastC5Price.replace(/[^\d.]/g, ''));
        if (isNaN(currentPrice)) return;

        const lastPrice = lastAlertedRef.current.get(item.hashName);

        // Trigger if price CROSSES the threshold OR if it's the first time seeing this alertable state
        let triggered = false;
        let msg = '';

        if (item.minAlert && currentPrice <= parseFloat(item.minAlert)) {
          if (lastPrice === undefined || lastPrice > parseFloat(item.minAlert)) {
            triggered = true;
            msg = `价格已低于预警值 ¥${item.minAlert}`;
          }
        } else if (item.maxAlert && currentPrice >= parseFloat(item.maxAlert)) {
          if (lastPrice === undefined || lastPrice < parseFloat(item.maxAlert)) {
            triggered = true;
            msg = `价格已高于预警值 ¥${item.maxAlert}`;
          }
        }

        if (triggered) {
          addNotification({
            title: item.name || item.hashName,
            message: msg,
            price: `当前价: ¥${currentPrice.toFixed(2)}`,
            image: item.image,
            type: 'alert',
            persistent: true
          });
        }

        // Update the reference so we don't spam
        lastAlertedRef.current.set(item.hashName, currentPrice);
      });

      setTrackedItems(data);
    } catch (e) {
      console.error('Failed to fetch tracked items');
    }
  };

  const fetchPrices = async () => {
    if (!item) return;
    setLoading(true);
    setError(null);
    setSeriesResults([]);

    // Use the first active currency for search preview
    const searchCurrency = settings.activeCurrencies.includes('CNY') ? 'CNY' : 'USD';

    try {
      const response = await api.get(`search-series?q=${encodeURIComponent(item)}&currency=${searchCurrency}`);
      const results = response.data;
      console.log('Search Results from Backend:', results);
      setSeriesResults(results);
      setSelectedHashNames(new Set(results.map(r => r.hash_name)));
    } catch (err) {
      if (err.response && err.response.status === 401) {
        setError('登录会话已过期或未授权，请验证密码。');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };


  const getSeriesName = (hashName) => {
    let groupKey = hashName.replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '').replace(/\s*[（\(].*?[）\)]\s*$/, '');
    if (groupKey.toLowerCase().includes('case') || groupKey.toLowerCase().includes('capsule')) {
      groupKey = groupKey.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
    }
    return groupKey;
  };

  const addTrack = async (r) => {
    setLoading(true);
    try {
      const payload = {
        items: [{
          name: r.name,
          hashName: r.hash_name || r.hashName,
          steamPrice: r.price || r.lastSteamPrice,
          image: r.image
        }],
        interval: selectedInterval
      };
      const res = await api.post('tracked/batch', payload);
      if (res.status === 200) {
        fetchTracked();
        // Trigger immediate update
        const nameFor = r.name || r.hash_name || r.hashName;
        let sName = nameFor
          .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
          .replace(/\s*[（\(].*?[）\)]\s*$/, '');
        const tMatch = sName.match(/^(\d{4}年.*?锦标赛|.*? \d{4})\b/);
        if (tMatch) sName = tMatch[1];
        else if (sName.toLowerCase().includes('case') || sName.toLowerCase().includes('capsule')) {
          sName = sName.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
        }
        handleManualUpdate(sName);
      }
    } catch (e) {
      console.error('Single add failed', e);
    } finally {
      setLoading(false);
    }
  };


  const addBatchToTrack = async () => {
    const toAdd = seriesResults.filter(r => selectedHashNames.has(r.hash_name));
    if (toAdd.length === 0) return;

    setLoading(true);
    try {
      const payload = {
        items: toAdd.map(r => ({
          name: r.name,
          hashName: r.hash_name,
          steamPrice: r.price,
          image: r.image
        })),
        interval: selectedInterval
      };
      const res = await api.post('tracked/batch', payload);

      if (res.status === 200) {
        fetchTracked();
        setSelectedHashNames(new Set());
        setSeriesResults([]);

        // Trigger immediate update - compute groupKey from Chinese name (same as backend)
        const firstItem = toAdd[0];
        const nameFor = firstItem.name || firstItem.hash_name;
        let sName = nameFor
          .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
          .replace(/\s*[（\(].*?[）\)]\s*$/, '');
        const tMatch = sName.match(/^(\d{4}年.*?锦标赛|.*? \d{4})\b/);
        if (tMatch) sName = tMatch[1];
        else if (sName.toLowerCase().includes('case') || sName.toLowerCase().includes('capsule')) {
          sName = sName.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
        }
        handleManualUpdate(sName);
      } else {
        alert('批量添加失败');
      }
    } catch (e) {
      console.error('Batch add failed', e);
      alert('批量添加请求失败: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  const handleMoveSeries = async (groupKey, direction) => {
    try {
      const res = await api.post('tracked/reorder', { groupKey, direction });
      if (res.status === 200) fetchTracked();
    } catch (e) {
      console.error('Failed to move series');
    }
  };

  const handleIntervalChange = async (hashName, newInterval) => {
    try {
      const res = await api.patch('/tracked/interval', { hashName, interval: newInterval });
      if (res.status === 200) fetchTracked();
    } catch (e) {
      console.error('Update interval failed');
    }
  };

  const toggleSelection = (hashName) => {
    const next = new Set(selectedHashNames);
    if (next.has(hashName)) next.delete(hashName);
    else next.add(hashName);
    setSelectedHashNames(next);
  };

  const removeFromTracked = async (hashName) => {
    try {
      await api.delete(`/tracked?hashName=${encodeURIComponent(hashName)}`);
      fetchTracked();
    } catch (e) {
      console.error('Failed to remove item');
    }
  };

  const handleSeriesIntervalChange = async (baseName, newInterval) => {
    try {
      const res = await api.patch('/tracked/series-interval', { baseName, interval: newInterval });
      if (res.status === 200) fetchTracked();
    } catch (e) {
      console.error('Update series interval failed');
    }
  };

  const handleToggleExcludeSeries = async (groupKey, targetExclude) => {
    try {
      const res = await api.post('tracked/exclude-series', { groupKey, exclude: targetExclude });
      if (res.status === 200) fetchTracked();
    } catch (e) {
      console.error('Toggle series exclusion failed');
    }
  };

  const handleToggleExcludeItem = async (hashName, currentExclude) => {
    try {
      const nextExclude = !currentExclude;
      const res = await api.post('tracked/exclude', { hashName, exclude: nextExclude });
      if (res.status === 200) fetchTracked();
    } catch (e) {
      console.error('Toggle item exclusion failed');
    }
  };

  // Group items by Series
  const getBestRatioForGroup = (subItems) => {
    const ratios = subItems.map(item => {
      const r = getRatio(item.steamPrices?.CNY, item.lastC5Price);
      return (r && r !== 'N/A') ? parseFloat(r) : 999;
    });
    return Math.min(...ratios);
  };

  const toggleSort = () => {
    setSortConfig(prev => ({
      key: 'ratio',
      direction: prev.direction === 'asc' ? 'desc' : (prev.direction === 'desc' ? 'none' : 'asc')
    }));
  };

  const groupedTracked = trackedItems.reduce((acc, item) => {
    // Robust regex to handle English and Chinese StatTrak prefixes and wear suffixes
    // We group by hashName for stability, but we'll display the name in the card header.
    // Robust grouping: First remove StatTrak and Wear
    let groupKey = (item.name || item.hashName).replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '').replace(/\s*[（\(].*?[）\)]\s*$/, '');

    // 1. Identify Tournament prefixes (e.g. 2025年布达佩斯锦标赛 or Budapest 2025)
    // We look for 4-digit years or specific tournament keywords
    const tournamentMatch = groupKey.match(/^(\d{4}年.*?锦标赛|.*? \d{4})/);
    if (tournamentMatch) {
      groupKey = tournamentMatch[1];
    } else {
      // 2. Fallback: Group numbered variants (e.g. Prisma 2 Case -> Prisma Case)
      if (groupKey.toLowerCase().includes('case') || groupKey.toLowerCase().includes('capsule')) {
        groupKey = groupKey.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
      }
    }

    if (!acc[groupKey]) acc[groupKey] = [];
    acc[groupKey].push(item);
    return acc;
  }, {});

  const [expandedSeries, setExpandedSeries] = useState(new Set());
  const [updatingSeries, setUpdatingSeries] = useState(new Set());

  const toggleSeries = (groupKey) => {
    const next = new Set(expandedSeries);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    setExpandedSeries(next);
  };

  const getRatio = (steamCNY, c5Price) => {
    if (!steamCNY || !c5Price || c5Price === 'N/A') return null;
    const sStr = steamCNY.toString();
    if (sStr.includes('$')) return null; // Currency mismatch
    const s = parseFloat(sStr.replace(/[^\d.]/g, ''));
    const y = parseFloat(c5Price);
    if (isNaN(s) || isNaN(y) || s <= 0) return null;
    return (y / s).toFixed(3);
  };

  const getBrickRatio = (steamCNY, c5Price) => {
    if (!steamCNY || !c5Price || c5Price === 'N/A') return null;
    const sStr = steamCNY.toString();
    if (sStr.includes('$')) return null; // Currency mismatch
    const s = parseFloat(sStr.replace(/[^\d.]/g, ''));
    const y = parseFloat(c5Price);
    if (isNaN(s) || isNaN(y) || y <= 0 || s <= 0) return null;
    return (s / y).toFixed(2);
  };

  const handleOpenBrowser = async (url, browserPath, profileName, browserType, profilePath) => {
    try {
      const res = await api.post('open-browser', {
        url,
        browserPath,
        profileName,
        browserType,
        profilePath
      });
      if (res.status !== 200) {
        const errText = res.data?.error || 'Unknown error';
        console.warn('Custom browser launch failed:', errText);
        alert(`启动浏览器失败: ${errText || '未知后端错误'}\n正在尝试普通窗口打开...`);
        window.open(url, '_blank');
      }
    } catch (e) {
      console.error('Network error calling open-browser API', e);
      alert(`无法连接到后台服务器: ${e.message}\n请确保后台 (server/index.js) 正在运行。\n正在尝试普通窗口打开...`);
      window.open(url, '_blank');
    }
  };

  const handleOpenSteamMarket = (hashName) => {
    // 1. 获取当前主选账号
    const acc = steamAccounts.find(a => String(a.id) === String(activeAccountId));

    if (!acc) {
      console.error('[跳转失败] 找不到当前选中账号对应的配置', activeAccountId);
      alert('请先在顶部选择一个有效的 Steam 账号');
      return;
    }

    // 2. 构造地址
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hashName)}`;

    // 3. 调用与“登录账号”按钮完全一致的核心函数
    console.log(`[跳转测试] 准备使用账号 "${acc.name}" 打开饰品页:`, acc.profilePath);
    handleOpenBrowser(
      url,
      acc.browserPath,
      acc.profile,
      acc.browserType || 'edge',
      acc.profilePath
    );
  };

  const handleDeleteSeries = async (baseName, count) => {
    if (!window.confirm(`确定要停用并删除“${baseName}”系列下的所有 ${count} 个版本吗？此操作无法撤销。`)) return;

    try {
      const res = await api.delete(`/tracked/series?baseName=${encodeURIComponent(baseName)}`);
      if (res.status === 200) {
        fetchTracked();
      } else {
        const err = res.data;
        alert(err.error || '删除失败');
      }
    } catch (e) {
      console.error('Delete series failed:', e);
      alert('网络错误，删除失败');
    }
  };

  const syncWealth = async (id) => {
    setIsSyncing(true);
    setActiveAccountId(id); // Ensure the correct row shows loading
    try {
      const res = await api.post('accounts/sync', { id }, { timeout: 180000 }); // 3 min: large inventories need time
      if (res.status === 200) {
        await fetchAccounts();
        fetchInventorySummary(); // Update total counts after sync
      } else {
        const err = res.data;
        if (err.error && err.error.includes('already running')) {
          if (window.confirm('同步失败：浏览器仍在后台运行。\n\n是否尝试“强制关闭”并重新同步？')) {
            await forceKillSync(id);
            return;
          }
        }
        alert(`${id} 同步失败: ${err.error || '未知错误'}`);
      }
    } catch (e) {
      console.error('Sync error:', e);
      const errMsg = e.response?.data?.error || e.message || '未知错误';
      if (errMsg.includes('already running') || errMsg.includes('browser')) {
        if (window.confirm(`⚠️ 同步失败：检测到账号对应的浏览器窗口仍在运行。\n\n请先关闭该账号的 Edge/Chrome 窗口，再重新同步。\n\n是否尝试强制关闭并重新同步？`)) {
          await forceKillSync(id);
          return;
        }
      } else {
        alert(`同步失败: ${errMsg}`);
      }
    } finally {
      setIsSyncing(false);
    }
  };
  const syncAllAccounts = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      // 已启用 Webshare 代理，并发提升至 10
      const CONCURRENCY = 10;
      const queue = [...steamAccounts];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) =>
        (async () => {
          if (i > 0) await new Promise(r => setTimeout(r, i * 200)); // 错步快速启动
          while (queue.length > 0) {
            const acc = queue.shift();
            if (acc) {
                const t0 = Date.now();
                await syncWealth(acc.id).catch(() => { }); 
                // 缩短安全间隔
                const elapsed = Date.now() - t0;
                const gap = Math.max(0, 500 - elapsed) + Math.random() * 200;
                if (gap > 0 && queue.length > 0) await new Promise(r => setTimeout(r, gap));
            }
          }
        })()
      );
      await Promise.all(workers);
      addNotification({ title: '同步结束', message: '所有账号库存同步完成！', type: 'success' });
    } catch (e) {
      addNotification({ title: '批量同步终止', message: e.message || '未知异常', type: 'error' });
    } finally {
      setIsSyncing(false);
    }
  };


  const fetchInventory = async (id, name) => {
    setInventoryLoading(true);
    setIsInventoryModalOpen(true);
    setViewingAccountName(name);
    setViewingAccountId(id);
    setInventoryData(null);
    try {
      const res = await api.get(`/accounts/inventory/${id}`);
      if (res.status === 200) {
        setInventoryData(res.data);
      } else {
        const err = res.data;
        alert(err.error || '获取库存失败');
        setIsInventoryModalOpen(false);
      }
    } catch (e) {
      alert('无法连接到服务器获取库存');
      setIsInventoryModalOpen(false);
    } finally {
      setInventoryLoading(false);
    }
  };

  const fetchMarketListings = async (id, name) => {
    setListingsLoading(true);
    setIsListingsModalOpen(true);
    setViewingAccountName(name);
    setViewingAccountId(id);
    setActiveListings([]);
    setSelectedListings([]); // Reset selections
    try {
      const res = await api.get(`/accounts/market-listings?id=${id}`);
      if (res.status === 200) {
        setActiveListings(res.data);
      }
    } catch (e) {
      console.error('Fetch listings error:', e);
      alert('获取上架清单失败：' + (e.response?.data?.error || e.message));
    } finally {
      setListingsLoading(false);
    }
  };

  const handleRemoveListing = async (listingId) => {
    if (!window.confirm('确定要下架该饰品吗？')) return;

    try {
      const res = await api.post('accounts/remove-listing', {
        accountId: viewingAccountId,
        listingId
      });

      if (res.data.success) {
        // Refresh local state to avoid re-fetch
        setActiveListings(prev => prev.filter(l => l.listingId !== listingId));
        setSelectedListings(prev => prev.filter(id => id !== listingId));
        addNotification({
          title: '下架成功',
          msg: '饰品已从 Steam 市场成功撤回',
          type: 'info'
        });
        fetchInventorySummary();
      }
    } catch (e) {
      console.error('Remove listing error:', e);
      alert('下架失败：' + (e.response?.data?.error || e.message));
    }
  };

  const handleBatchRemove = async () => {
    if (selectedListings.length === 0) return;
    if (!window.confirm(`确定要批量下架选中的 ${selectedListings.length} 件饰品吗？`)) return;

    setListingsLoading(true);
    try {
      const res = await api.post('accounts/batch-remove-listings', {
        accountId: viewingAccountId,
        listingIds: selectedListings
      });

      const { success, failed } = res.data;

      // Update local state
      setActiveListings(prev => prev.filter(l => !success.includes(l.listingId)));
      setSelectedListings([]);

      addNotification({
        title: '批量处理完成',
        msg: `成功下架 ${success.length} 件，失败 ${failed.length} 件`,
        type: failed.length > 0 ? 'warning' : 'info'
      });
      fetchInventorySummary();

      if (failed.length > 0) {
        console.error('Batch removal failures:', failed);
      }
    } catch (e) {
      console.error('Batch removal error:', e);
      alert('批量下架失败：' + (e.response?.data?.error || e.message));
    } finally {
      setListingsLoading(false);
    }
  };

  const toggleSelectListing = (id) => {
    setSelectedListings(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedListings.length === activeListings.length) {
      setSelectedListings([]);
    } else {
      setSelectedListings(activeListings.map(l => l.listingId));
    }
  };

  const openSellDialog = async (item, assetids) => {
    setSellDialog({ item, assetids });
    setSellSellerPrice('');
    setSellBuyerPrice('');
    setSellQuantity(1);
    setMarketPriceInfo({ loading: true });

    try {
      const hashName = item.market_hash_name || item.market_name;
      const res = await api.get('market-price', { params: { hashName }, timeout: 8000 });
      const d = res.data;
      if (d && d.lowest_price) {
        setMarketPriceInfo({
          lowest_price: d.lowest_price,
          median_price: d.median_price,
          listings: d.listings
        });
        // Parse lowest_price (e.g. "¥ 1.97") and pre-fill seller price
        const numStr = d.lowest_price.replace(/[^\d.]/g, '');
        const lowestBuyerVal = parseFloat(numStr);
        if (lowestBuyerVal > 0) {
          // Default to Lowest - 0.01 (in currency units, e.g. 1 cent)
          const targetBuyerVal = Math.max(0.01, lowestBuyerVal - 0.01);
          const buyerFen = Math.round(targetBuyerVal * 100);

          // Use the precise Steam fee formula
          const sellerFen = steamBuyerToSellerFen(buyerFen);
          setSellSellerPrice((sellerFen / 100).toFixed(2));
          setSellBuyerPrice((buyerFen / 100).toFixed(2));
        }
      } else {
        setMarketPriceInfo({ error: '暂无价格数据' });
      }
    } catch {
      setMarketPriceInfo({ error: '价格获取失败' });
    }
  };

  // Steam fee: buyer pays seller + floor(seller*5%) + floor(seller*10%)
  const steamSellerToBuyerFen = (sellerFen) =>
    sellerFen + Math.floor(sellerFen * 0.05) + Math.floor(sellerFen * 0.10);

  const steamBuyerToSellerFen = (buyerFen) => {
    let s = Math.floor(buyerFen / 1.15); // initial estimate
    while (steamSellerToBuyerFen(s) < buyerFen) s++;
    while (steamSellerToBuyerFen(s) > buyerFen) s--;
    return s;
  };

  const handleSellerPriceChange = (val) => {
    setSellSellerPrice(val);
    const n = parseFloat(val);
    if (isNaN(n)) { setSellBuyerPrice(''); return; }
    const buyerFen = steamSellerToBuyerFen(Math.round(n * 100));
    setSellBuyerPrice((buyerFen / 100).toFixed(2));
  };

  const handleBuyerPriceChange = (val) => {
    setSellBuyerPrice(val);
    const n = parseFloat(val);
    if (isNaN(n)) { setSellSellerPrice(''); return; }
    const sellerFen = steamBuyerToSellerFen(Math.round(n * 100));
    setSellSellerPrice((sellerFen / 100).toFixed(2));
  };

  const confirmSell = async () => {
    if (!sellDialog || !sellSellerPrice || parseFloat(sellSellerPrice) <= 0) return;
    if (!viewingAccountId || viewingAccountId === 'total') {
      alert('汇总视图不支持直接上架，请打开单个账号库存后操作。');
      return;
    }
    if (!sellDialog.assetids || sellDialog.assetids.length === 0) {
      alert('无法获取该物品的 ID，请尝试重新同步或打开单个账号库存。');
      return;
    }
    const qty = Math.min(Math.max(1, parseInt(sellQuantity) || 1), sellDialog.assetids.length);
    setIsSelling(true);
    // 以「上架价格」（买家支付）为准，回退到到手价确保不为空
    const buyerPriceFen = Math.round(parseFloat(sellBuyerPrice) * 100);
    const sellerPriceFen = (!isNaN(buyerPriceFen) && buyerPriceFen > 0)
      ? steamBuyerToSellerFen(buyerPriceFen)
      : Math.round(parseFloat(sellSellerPrice) * 100);
    if (!sellerPriceFen || sellerPriceFen <= 0) {
      alert('请先填写上架价格');
      setIsSelling(false);
      return;
    }
    let successCount = 0;
    const soldAssetIds = [];
    let lastErrorMessage = '';

    for (let i = 0; i < qty; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 800));
        const assetidToSell = sellDialog.assetids[i];
        const res = await api.post(`/accounts/${viewingAccountId}/sell-item`, {
          assetid: assetidToSell,
          sellerPriceFen
        });
        if (res.data.success) {
          successCount++;
          soldAssetIds.push(assetidToSell);
          setInventoryData(prev => prev ? {
            ...prev,
            assets: prev.assets.filter(a => a.assetid !== assetidToSell)
          } : prev);
        } else {
          lastErrorMessage = res.data.error || '未知错误';
          console.error(`第 ${i + 1} 个上架失败: ${lastErrorMessage}`);
        }
      } catch (itemErr) {
        lastErrorMessage = itemErr.response?.data?.error || itemErr.message;
        console.error(`第 ${i + 1} 个上架请求异常:`, lastErrorMessage);
      }
    }

    if (successCount > 0) {
      addNotification({
        title: '✅ 上架成功',
        message: `${sellDialog.item.name || sellDialog.item.market_name} ×${successCount} 已挂出，到手价 ¥${sellSellerPrice}`,
        type: 'success'
      });
      setSellDialog(null);
      fetchInventorySummary();
    } else if (!isSelling) {
      // If we got here and successCount is 0, it means all attempts failed
      alert(`挂售失败: ${lastErrorMessage || 'Steam 拒绝了请求，请检查账号状态或稍后再试。'}`);
    }
    setIsSelling(false);
  };

  const fetchTotalInventory = async () => {
    setIsInventoryModalOpen(true);
    setInventoryLoading(true);
    setInventoryData(null);
    setViewingAccountName('汇总 (全账号)');
    setViewingAccountId('total');
    try {
      const res = await api.get('inventory/total');
      if (res.status === 200) {
        setInventoryData(res.data);
      }
    } catch (e) {
      console.error('Failed to fetch total inventory');
      alert('无法连接到服务器获取总库存');
      setIsInventoryModalOpen(false);
    } finally {
      setInventoryLoading(false);
    }
  };

  const getRarityInfo = (typeString) => {
    if (!typeString) return { label: '未分类', color: '#B0C3D9' };

    // Mapping rules based on user request
    if (typeString.includes('Covert') || typeString.includes('隐秘'))
      return { label: '隐秘', color: '#EB4B4B' };
    if (typeString.includes('Classified') || typeString.includes('保密'))
      return { label: '保密', color: '#D32CE6' };
    if (typeString.includes('Restricted') || typeString.includes('受限'))
      return { label: '受限', color: '#8847FF' };
    if (typeString.includes('Mil-Spec Grade') || typeString.includes('军规级'))
      return { label: '军规级', color: '#4B69FF' };
    if (typeString.includes('Industrial Grade') || typeString.includes('工业级'))
      return { label: '工业级', color: '#5E98D9' };
    if (typeString.includes('Consumer Grade') || typeString.includes('消费级'))
      return { label: '消费级', color: '#B0C3D9' };

    // Default or other types (Stickers, Cases, etc.)
    return { label: typeString, color: '#FFFFFF' };
  };

  const forceKillSync = async (id) => {
    const acc = steamAccounts.find(a => a.id === id);
    try {
      await api.post('accounts/kill-browser', { id, browserType: acc?.browserType || 'edge' });
      // Small delay to let OS processes cleanup
      setTimeout(() => syncWealth(id), 3000);
    } catch (e) {
      alert('强制关闭失败');
      setIsSyncing(false);
    }
  };

  const addAccount = async () => {
    const newId = Date.now().toString();

    let profilePath = 'C:\\Users\\31784\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\';
    try {
      const setupRes = await api.post('accounts/setup-profile');
      if (setupRes.status === 200) {
        const setupData = setupRes.data;
        profilePath = setupData.profilePath;
      }
    } catch (e) {
      console.warn('Failed to auto-create profile, falling back to default path');
    }

    const newAccs = [...steamAccounts, {
      id: newId,
      name: `账号 ${steamAccounts.length + 1}`,
      profile: 'Default',
      browserType: 'edge',
      profilePath: profilePath,
      browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      steamId64: '',
      balance: '¥ 0.00',
      inventoryValue: '¥ 0.00',
      lastSync: ''
    }];
    setSteamAccounts(newAccs);
    setActiveAccountId(newId);
    await api.post('accounts', newAccs);
  };

  const updateAccount = async (id, field, value) => {
    const nextAccounts = steamAccounts.map(a => a.id === id ? { ...a, [field]: value } : a);
    setSteamAccounts(nextAccounts);
    await api.post('accounts', nextAccounts);
  };

  // ─── C5 Handler Functions ─────────────────────────────────────────────────

  const fetchC5Balance = async () => {
    setC5BalanceLoading(true);
    try {
      const res = await api.get('c5/balance');
      if (res.data.success) setC5Balance(res.data.data);
    } catch (e) {
      console.error('C5 余额查询失败:', e);
      addNotification({ title: 'C5 余额获取失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setC5BalanceLoading(false);
    }
  };

  /**
   * 持久重试式库存拉取：一次不行就再来一次，直到成功为止
   * @param {string} steamId64 目标 SteamID64
   * @param {string} [accountName] 用于日志显示
   * @param {number} [maxAttempts=15] 最多尝试次数（0 表示无限）
   * @returns {Promise<{items: Array, success: boolean, private?: boolean, rateLimited?: boolean}>}
   */
  const fetchSteamInventoryWithRetry = async (steamId64, accountName = steamId64, maxAttempts = 15) => {
    let attempt = 0;
    const RETRY_DELAY_MS = 3000;
    while (true) {
      attempt++;
      try {
        const res = await api.get(`steam/inventory/${steamId64}`, { timeout: 42000 });
        // 成功或明确错误直接返回
        if (res.data.rateLimited) return { success: false, rateLimited: true, items: [] };
        if (res.data.private)    return { success: false, private: true, items: [] };
        // Steam 的 10 天新物品隐藏机制：直接返回不重试
        if (res.data.data?.hiddenByNewItemRule) return { success: true, items: [], hiddenByNewItemRule: true };
        if (res.data.success)    return { success: true, items: res.data.data?.items || [] };
        // Steam 返回了非成功的其他情况，继续重试
        console.warn(`[InvRetry] ${accountName} 第${attempt}次：Steam 返回错误: ${res.data.error || '未知'}`);
      } catch (e) {
        const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout');
        console.warn(`[InvRetry] ${accountName} 第${attempt}次 ${isTimeout ? '跌诇45s超时' : e.message}，等待${RETRY_DELAY_MS/1000}s后重试...`);
      }
      if (maxAttempts > 0 && attempt >= maxAttempts) {
        return { success: false, items: [], error: `已达到最大重试次数 (${maxAttempts})` };
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  };

  const syncPersonaNames = async () => {
    if (isSyncingPersonas) return;
    setIsSyncingPersonas(true);
    addNotification({ title: '同步昵称', message: '正在向 Steam 拉取账号公开昵称，请稍候...', type: 'info' });
    try {
      const res = await api.post('accounts/sync-personas', {}, { timeout: 120000 });
      if (res.data.success && res.data.updated) {
        setSteamAccounts(prev => prev.map(acc => {
          const found = res.data.updated.find(u => u.id === acc.id);
          return found ? { ...acc, personaName: found.personaName } : acc;
        }));
        addNotification({ title: '同步完成', message: `成功更新了 ${res.data.updated.length} 个账号的昵称`, type: 'success' });
      }
    } catch (e) {
      console.warn('[Persona] 同步失败:', e.message);
      addNotification({ title: '同步失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setIsSyncingPersonas(false);
    }
  };

  const fetchC5Inventory = async (steamId) => {
    if (!steamId) return;
    setC5InventoryLoading(true);
    setC5Inventory([]);
    const acc = steamAccounts.find(a => a.steamId64 === steamId);
    const meta = { _merchantId: acc?.c5MerchantId || selectedMerchantId, _accountId: acc?.id, _accountName: acc?.name, _steamId: steamId };
    try {
      let fetched = false;

      // Step 1: Try C5 API if the account has a merchant association
      if (acc?.c5MerchantId) {
        try {
          const res = await api.get(`c5/inventory/${steamId}`);
          if (res.data.success) {
            const raw = Array.isArray(res.data.data) ? res.data.data : (res.data.data?.list || res.data.data?.items || []);
            if (raw.length > 0) {
              setC5Inventory(raw.map(i => ({ ...i, ...meta })));
              fetched = true;
            }
            // C5 returned 0 items → account not truly bound, fall through to Steam
          }
        } catch (c5Err) {
          console.warn(`[单账号库存] C5 接口失败 (${c5Err.message})，转 Steam 公开库存`);
        }
      }

      // Step 2: Fallback to Steam public inventory API (with persistent retry)
      if (!fetched) {
        const result = await fetchSteamInventoryWithRetry(steamId, acc?.name || steamId);
        if (result.rateLimited) {
          addNotification({ title: '⛔ 库存获取中断', message: 'Steam 429 限频，请稍后再试', type: 'error' });
        } else if (result.hiddenByNewItemRule) {
          addNotification({ title: '⏳ 新物品隐藏中', message: `${acc?.name || steamId} 的饰品因 Steam 10天新物品规则暂时无法通过 API 获取，约 10 天后自动显示`, type: 'warning' });
        } else if (result.success) {
          setC5Inventory((result.items || []).map(i => ({ ...i, ...meta })));
        } else if (result.private) {
          addNotification({ title: '库存不可见', message: '该账号库存已设为私密', type: 'warning' });
        } else {
          addNotification({ title: '库存获取失败', message: result.error || '未知错误', type: 'error' });
        }
      }
    } catch (e) {
      addNotification({ title: '库存获取失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setC5InventoryLoading(false);
    }
  };


  const fetchC5Listings = async (steamId) => {
    if (!steamId) return;
    setC5ListingsLoading(true);
    setC5Listings([]);
    try {
      const res = await api.get(`c5/listings/${steamId}`);
      if (res.data.success) setC5Listings(Array.isArray(res.data.data) ? res.data.data : (res.data.data?.list || []));
    } catch (e) {
      addNotification({ title: 'C5 挂单获取失败', message: e.response?.data?.error || e.message, type: 'error' });
    } finally {
      setC5ListingsLoading(false);
    }
  };

  const handleC5SelectAccount = (accountId) => {
    setSelectedC5AccountId(accountId);
    const acc = steamAccounts.find(a => a.id === accountId);
    if (acc?.steamId64) {
      if (c5AccountSubTab === 'inventory') fetchC5Inventory(acc.steamId64);
      else fetchC5Listings(acc.steamId64);
    }
  };

  const handleC5SubTabChange = (tab) => {
    setC5AccountSubTab(tab);
    const acc = steamAccounts.find(a => a.id === selectedC5AccountId);
    if (!acc?.steamId64) return;
    if (tab === 'inventory') fetchC5Inventory(acc.steamId64);
    else fetchC5Listings(acc.steamId64);
  };

  const handleSaveTradeUrl = async (id) => {
    try {
      await api.put(`accounts/${id}/trade-url`, { tradeUrl: tradeUrlInput.trim() || null });
      setSteamAccounts(prev => prev.map(a => a.id === id ? { ...a, tradeUrl: tradeUrlInput.trim() || null } : a));
      setEditingTradeUrlId(null);
      addNotification({ title: '交易链接已保存', type: 'info' });
    } catch (e) {
      addNotification({ title: '保存失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  const handleC5ListItem = async () => {
    const targetAccountId = c5ListingItemObj?._accountId || selectedC5AccountId;
    if (!c5ListingToken || !c5ListPriceInput || !targetAccountId) {
      if (!targetAccountId) addNotification({ title: '参数不全', message: '请先在上方选择一个账号', type: 'error' });
      return;
    }
    const acc = steamAccounts.find(a => a.id === targetAccountId);
    if (!acc?.steamId64) return alert('请先选择一个有 SteamID 的账号');

    const allTokens = c5ListingItemObj?._allTokens || [c5ListingToken];
    const qty = Math.min(Math.max(1, parseInt(c5ListQuantity) || 1), allTokens.length);
    const tokensToList = allTokens.slice(0, qty);

    const payloadItems = tokensToList.map(tok => ({
      token: tok,
      styleToken: c5ListingItemObj?.styleToken,
      price: parseFloat(c5ListPriceInput)
    }));

    try {
      const res = await api.post('c5/list-item', { items: payloadItems, merchantId: acc?.c5MerchantId || selectedMerchantId });
      if (res.data.success) {
        addNotification({ title: `C5 上架成功 ${tokensToList.length} 件`, type: 'info' });
      }
    } catch (e) {
      addNotification({ title: 'C5 上架失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
    setC5ListingToken(null);
    setC5ListingItemObj(null);
    setC5ListPriceInput('');
    setC5ListQuantity(1);

    // Wait briefly for C5 to register the new listing before refreshing
    // (C5 backend may have ~1s delay before the listing appears in the search API)
    await new Promise(r => setTimeout(r, 1500));
    if (c5InventoryViewMode === 'all') {
      fetchC5AllInventory();
    } else if (acc?.steamId64) {
      fetchC5Inventory(acc.steamId64);
    }
  };

  const handleC5Delist = async (saleId) => {
    if (!saleId) {
      console.warn('[C5下架] 传入的 saleId 为空');
      return addNotification({ title: '无法下架', message: '未找到有效的挂单ID', type: 'error' });
    }
    if (!window.confirm('确认下架该 C5 挂单？')) return;
    const acc = steamAccounts.find(a => a.id === selectedC5AccountId);
    const merchantId = acc?.c5MerchantId || selectedMerchantId;
    try {
      await api.put('c5/delist', { saleId, merchantId });
      addNotification({ title: 'C5 下架成功', type: 'info' });
      if (acc?.steamId64) {
        fetchC5Listings(acc.steamId64);
        fetchC5Inventory(acc.steamId64);
      }
      if (c5InventoryViewMode === 'all') fetchC5AllInventory();
    } catch (e) {
      console.error('[C5下架] 请求异常:', e);
      const errMsg = e.response?.data?.error || e.message || '';
      const alreadyDelisted = errMsg.includes('已下架') || errMsg.includes('already') || errMsg.includes('不存在');
      if (alreadyDelisted) {
        addNotification({
          title: '该饰品已不在售',
          message: '可能已成交或被其他操作下架，正在自动刷新库存...',
          type: 'warning'
        });
        // Auto-refresh to sync state
        if (acc?.steamId64) {
          fetchC5Listings(acc.steamId64);
          fetchC5Inventory(acc.steamId64);
        }
        if (c5InventoryViewMode === 'all') fetchC5AllInventory();
      } else {
        addNotification({ title: 'C5 下架失败', message: errMsg, type: 'error' });
      }
    }
  };

  const handleC5ModifyPrice = async () => {
    if (!c5ModifyDialog) {
      return addNotification({ title: '数据异常', message: '由于缺少弹窗上下文，无法改价', type: 'error' });
    }
    if (!c5ModifyPriceInput) {
      return addNotification({ title: '输入错误', message: '价格不能为空白', type: 'error' });
    }

    const targetAccountId = c5ModifyDialog.item?._accountId || selectedC5AccountId;
    const acc = steamAccounts.find(a => a.id === targetAccountId);

    const item = c5ModifyDialog.item;
    const allTokens = item?._allTokens || [item.token];
    const qty = Math.min(Math.max(1, parseInt(c5ModifyQuantity) || 1), allTokens.length);
    const tokensToModify = allTokens.slice(0, qty);

    const allItems = [...(c5Inventory || []), ...(c5AllInventory || [])];
    const payloadItems = [];

    for (const tok of tokensToModify) {
      const dbItem = allItems.find(i => i.token === tok);
      const listMatch = (c5Listings || []).find(l => l.token === tok || (l.assetInfo && l.assetInfo.token === tok));
      const fallbackSaleId = item.token === tok ? c5ModifyDialog.saleId : null;
      const saleId = dbItem?.productId || dbItem?.saleId || listMatch?.id || dbItem?.id || fallbackSaleId;

      if (saleId) {
        payloadItems.push({ saleId, price: parseFloat(c5ModifyPriceInput) });
      } else {
        console.warn(`[C5改价] 未找到 token 对应的 saleId: ${tok}`, { dbItem, listMatch, fallbackSaleId });
      }
    }

    if (payloadItems.length === 0) {
      addNotification({ title: '改价中断', message: `未能获取到有效的挂单ID，系统拦截了请求`, type: 'error' });
    } else {
      try {
        const res = await api.put('c5/modify-price', { items: payloadItems, merchantId: acc?.c5MerchantId || selectedMerchantId });
        if (res.data.success) {
          addNotification({ title: `C5 改价发布成功 ${payloadItems.length} 件`, type: 'info' });

          // Optimistic UI Data Update: instantly display new price before next fetch
          const newPriceStr = parseFloat(c5ModifyPriceInput).toFixed(2);
          const updatePrice = (itemsList) => {
            if (!itemsList) return itemsList;
            return itemsList.map(i => {
              if (tokensToModify.includes(i.token) || payloadItems.some(p => p.saleId === i.productId || p.saleId === i.saleId || p.saleId === i.id)) {
                return { ...i, price: newPriceStr };
              }
              return i;
            });
          };
          setC5Inventory(prev => updatePrice(prev));
          setC5AllInventory(prev => updatePrice(prev));
        }
      } catch (e) {
        addNotification({ title: 'C5 改价发布失败', message: e.response?.data?.error || e.message, type: 'error' });
      }
    }

    setC5ModifyDialog(null);
    setC5ModifyPriceInput('');
    setC5ModifyQuantity(1);

    // Wait briefly for C5 to sync the price change before background refreshing
    await new Promise(r => setTimeout(r, 1500));

    if (acc?.steamId64) {
      fetchC5Listings(acc.steamId64);
      fetchC5Inventory(acc.steamId64);
    }
    if (c5InventoryViewMode === 'all') fetchC5AllInventory();
  };

  // ─── 批量下架（在售中视图）─────────────────────────────────
  const handleC5BatchDelist = async () => {
    if (c5SelectedTokens.size === 0) {
      return addNotification({ title: '请先选择在售中的饰品', type: 'error' });
    }
    if (!window.confirm(`确认批量下架已选的 ${c5SelectedTokens.size} 件饰品？`)) return;

    setC5BatchLoading(true);
    const allItems = [...(c5Inventory || []), ...(c5AllInventory || [])];
    const saleIds = [];
    let missingIdCount = 0;

    for (const token of c5SelectedTokens) {
      const item = allItems.find(i => i.token === token);
      const listMatch = c5Listings.find(l => l.token === token || (l.assetInfo && l.assetInfo.token === token));
      const saleId = item?.productId || item?.saleId || listMatch?.id || item?.id;
      if (saleId) {
        saleIds.push(saleId);
      } else {
        console.warn(`[C5批量下架] 未找到 saleId, token: ${token}`);
        missingIdCount++;
      }
    }

    const _acc = steamAccounts.find(a => a.id === selectedC5AccountId);
    if (saleIds.length > 0) {
      try {
        await api.put('c5/delist', { saleIds, merchantId: _acc?.c5MerchantId || selectedMerchantId });
        addNotification({
          title: '批量下架完成',
          message: `成功 ${saleIds.length} 件${missingIdCount > 0 ? `，失败 ${missingIdCount} 件(未找到挂单)` : ''}`,
          type: missingIdCount > 0 ? 'warning' : 'info'
        });

        // Optimistic UI Data Update: instantly display items as normal (status=0) before next fetch
        const updateStatus = (itemsList) => {
          if (!itemsList) return itemsList;
          return itemsList.map(i => {
            if (c5SelectedTokens.has(i.token)) {
              return { ...i, status: 0 };
            }
            return i;
          });
        };
        setC5Inventory(prev => updateStatus(prev));
        setC5AllInventory(prev => updateStatus(prev));

      } catch (e) {
        const lastError = e.response?.data?.error || e.message;
        console.error(`[C5批量下架] 失败:`, lastError);
        addNotification({ title: '批量下架失败', message: `错误: ${lastError}`, type: 'error' });
      }
    } else {
      addNotification({ title: '批量下架失败', message: '未找到任何所选商品的挂单ID', type: 'error' });
    }
    setC5SelectedTokens(new Set());
    setC5BatchLoading(false);

    // Wait briefly for C5 to sync the cancellation before background refreshing
    await new Promise(r => setTimeout(r, 1500));

    if (_acc?.steamId64) fetchC5Listings(_acc.steamId64);

    if (c5InventoryViewMode === 'all') fetchC5AllInventory();
    else if (_acc?.steamId64) fetchC5Inventory(_acc.steamId64);
  };

  // ─── 批量改价（在售中视图）─────────────────────────────────
  const handleC5BatchModifyPrice = async () => {
    if (c5SelectedTokens.size === 0 || !c5BatchModifyPriceInput) {
      return addNotification({ title: '请先选择饰品并填写新价格', type: 'error' });
    }
    setC5BatchModifyLoading(true);
    const allItems = [...(c5Inventory || []), ...(c5AllInventory || [])];
    const payloadItems = [];
    let missingIdCount = 0;

    for (const token of c5SelectedTokens) {
      const item = allItems.find(i => i.token === token);
      const listMatch = c5Listings.find(l => l.token === token || (l.assetInfo && l.assetInfo.token === token));
      const saleId = item?.productId || item?.saleId || listMatch?.id || item?.id;
      if (saleId) {
        payloadItems.push({ saleId, price: parseFloat(c5BatchModifyPriceInput) });
      } else {
        console.warn(`[C5批量改价] 未找到 saleId, token: ${token}`);
        missingIdCount++;
      }
    }

    const _acc2 = steamAccounts.find(a => a.id === selectedC5AccountId);
    if (payloadItems.length > 0) {
      try {
        await api.put('c5/modify-price', { items: payloadItems, merchantId: _acc2?.c5MerchantId || selectedMerchantId });
        addNotification({
          title: '批量改价完成',
          message: `成功 ${payloadItems.length} 件${missingIdCount > 0 ? `，失败 ${missingIdCount} 件(未找到挂单)` : ''}`,
          type: missingIdCount > 0 ? 'warning' : 'info'
        });

        // Optimistic UI Data Update: instantly display new price before next fetch
        const newPriceStr = parseFloat(c5BatchModifyPriceInput).toFixed(2);
        const updatePrice = (itemsList) => {
          if (!itemsList) return itemsList;
          return itemsList.map(i => {
            if (c5SelectedTokens.has(i.token)) {
              return { ...i, price: newPriceStr };
            }
            return i;
          });
        };
        setC5Inventory(prev => updatePrice(prev));
        setC5AllInventory(prev => updatePrice(prev));

      } catch (e) {
        const lastError = e.response?.data?.error || e.message;
        console.error(`[C5批量改价] 失败:`, lastError);
        addNotification({ title: '批量改价失败', message: `错误: ${lastError}`, type: 'error' });
      }
    } else {
      addNotification({ title: '批量改价失败', message: '未找到任何所选商品的挂单ID', type: 'error' });
    }
    setC5SelectedTokens(new Set());
    setC5BatchModifyPriceInput('');
    setC5BatchModifyLoading(false);

    // Wait briefly for C5 to sync the price change before background refreshing
    await new Promise(r => setTimeout(r, 1500));

    if (_acc2?.steamId64) fetchC5Listings(_acc2.steamId64);

    if (c5InventoryViewMode === 'all') fetchC5AllInventory();
    else if (_acc2?.steamId64) fetchC5Inventory(_acc2.steamId64);
  };

  // ─── C5 Status labels ──────────────────────────────────────────────────────
  const C5_STATUS_LABELS = {
    0: { label: '正常', color: '#22c55e' },
    1: { label: '在售中', color: '#38bdf8' },
    2: { label: '平台禁售', color: '#ef4444' },
    3: { label: '禁止交易', color: '#991b1b' },
    4: { label: '冷却中', color: '#f59e0b' },
    5: { label: '待发货', color: '#a855f7' },
    6: { label: '处理中', color: '#94a3b8' },
    7: { label: '可出租', color: '#14b8a6' },
  };

  const fetchC5AllInventory = async () => {
    setC5AllInventoryLoading(true);
    setC5AllInventory([]);
    setC5ListingsLoading(true);
    setC5Listings([]);

    const accsWithId = steamAccounts.filter(a => a.steamId64);
    const combined = [];
    const combinedListings = [];

    for (const acc of accsWithId) {
      try {
        const res = await api.get(`c5/inventory/${acc.steamId64}`);
        if (res.data.success) {
          const items = Array.isArray(res.data.data) ? res.data.data : (res.data.data?.list || []);
          items.forEach(item => combined.push({
            ...item,
            _accountName: acc.name,
            _accountId: acc.id,
            _steamId: acc.steamId64,
            _merchantId: acc.c5MerchantId || selectedMerchantId
          }));
        }
      } catch (e) { console.error(`[C5] ${acc.name} 库存获取失败:`, e.message); }

      try {
        const resList = await api.get(`c5/listings/${acc.steamId64}`);
        if (resList.data.success) {
          const lItems = Array.isArray(resList.data.data) ? resList.data.data : (resList.data.data?.list || []);
          lItems.forEach(l => combinedListings.push(l));
        }
      } catch (e) { console.error(`[C5] ${acc.name} 挂单获取失败:`, e.message); }
    }

    setC5AllInventory(combined);
    setC5AllInventoryLoading(false);
    setC5Listings(combinedListings);
    setC5ListingsLoading(false);
  };

  const handleC5BatchList = async () => {
    if (c5SelectedTokens.size === 0 || !c5BatchListPrice) {
      return addNotification({ title: '请先选择饰品并填写价格', type: 'error' });
    }

    setC5BatchLoading(true);
    let failedCount = 0;

    const allItems = [...(c5Inventory || []), ...(c5AllInventory || [])];
    const payloadItems = [];

    for (const token of c5SelectedTokens) {
      const item = allItems.find(i => i.token === token);
      if (!item || !item.styleToken) {
        console.warn(`[C5批上架] 数据缺失, token: ${token}`);
        failedCount++;
        continue;
      }
      payloadItems.push({
        token,
        styleToken: item.styleToken,
        price: parseFloat(c5BatchListPrice)
      });
    }

    if (payloadItems.length > 0) {
      try {
        await api.post('c5/list-item', { items: payloadItems });
        addNotification({
          title: '批量上架完成',
          message: `成功 ${payloadItems.length} 件${failedCount > 0 ? `，失败缺失凭证 ${failedCount} 件` : ''}`,
          type: failedCount > 0 ? 'warning' : 'info'
        });
      } catch (e) {
        const lastError = e.response?.data?.error || e.message;
        console.error(`[C5批上架] 失败:`, lastError);
        addNotification({ title: '批量上架失败', message: `错误信息: ${lastError}`, type: 'error' });
      }
    } else {
      addNotification({ title: '参数不全', message: '未能构建任何有效的上架数据', type: 'error' });
    }

    setC5SelectedTokens(new Set());
    setC5BatchListPrice('');
    setC5BatchLoading(false);

    const acc = steamAccounts.find(a => a.id === selectedC5AccountId);
    if (c5InventoryViewMode === 'all') fetchC5AllInventory();
    else if (acc?.steamId64) fetchC5Inventory(acc.steamId64);
  };

  const toggleC5Token = (tokens) => {
    setC5SelectedTokens(prev => {
      const next = new Set(prev);
      const allSelected = tokens.every(t => next.has(t));
      if (allSelected) tokens.forEach(t => next.delete(t));
      else tokens.forEach(t => next.add(t));
      return next;
    });
  };

  const handleC5BuySearch = async () => {
    if (!c5BuyHashName.trim()) return addNotification({ title: '请输入搜索关键词', type: 'error' });
    setC5BuyLoading(true);
    setC5BuyResults(null);
    try {
      // Use the reliable series search instead of direct C5 keyword search
      const res = await api.get('search-series', { params: { q: c5BuyHashName.trim() } });
      if (res.data) {
        setC5BuyResults(res.data);
      } else { setC5BuyResults([]); }
    } catch (e) {
      addNotification({ title: '搜索失败', message: e.response && e.response.data ? e.response.data.error : e.message, type: 'error' });
      setC5BuyResults([]);
    } finally { setC5BuyLoading(false); }
  };

  const handleC5BuySingle = async (item) => {
    if (!c5BuyAccountId) return addNotification({ title: '请先选择收货账号', type: 'error' });
    if (!item.c5Price || item.c5Price === 'N/A') return addNotification({ title: '无价格', message: '该饰品暂无 C5 在售价格可以购买', type: 'warning' });

    const acc = steamAccounts.find(a => a.id === c5BuyAccountId);
    if (!acc || !acc.tradeUrl) return addNotification({ title: '账号未配置交易链接', type: 'error' });

    setC5BuyLoading(true);
    try {
      const res = await api.post('c5/buy', {
        hashName: item.hash_name,
        price: item.c5Price,
        tradeUrl: acc.tradeUrl,
        merchantId: acc.c5MerchantId
      });
      if (res.data.success) {
        addNotification({ title: '挂拍成功', message: `已派发购买任务: ${item.name || item.hash_name}`, type: 'success' });
      }
    } catch (e) {
      addNotification({ title: '购买失败', message: e.response && e.response.data ? e.response.data.error : e.message, type: 'error' });
    } finally { setC5BuyLoading(false); }
  };


  const deleteAccount = async (id) => {
    if (steamAccounts.length <= 1) return alert('请至少保留一个账号');
    if (!window.confirm('确认删除该账号？')) return;
    const next = steamAccounts.filter(a => a.id !== id);
    setSteamAccounts(next);
    if (activeAccountId === id) setActiveAccountId(next[0]?.id || null);
    try {
      await api.delete(`accounts/${id}`);
    } catch (e) {
      console.error('Delete account failed:', e);
      alert('删除失败：' + (e.response?.data?.error || e.message));
      // Rollback on failure
      await fetchAccounts();
    }
  };

  const setInventoryPublic = async (id, name) => {
    if (id === 'ALL') {
      if (!window.confirm("确认要将【所有】带有 maFile 的账号库存全部一键设为公开吗？\n这可能需要几十秒时间。")) return;
      
      const targets = steamAccounts.filter(a => a.mafileContent);
      let successCount = 0;
      addNotification({ title: '批量设置中', message: `共 ${targets.length} 个账号待处理 (并发: 10)...`, type: 'info' });
      
      const CONCURRENCY = 10;
      const queue = [...targets];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) => 
        (async () => {
          if (i > 0) await new Promise(r => setTimeout(r, i * 300)); // 错步启动
          while (queue.length > 0) {
            const acc = queue.shift();
            if (!acc) continue;
            
            let attempts = 0;
            const MAX_ATTEMPTS = 3;
            let success = false;
            
            while (attempts < MAX_ATTEMPTS && !success) {
              attempts++;
              try {
                await api.post('accounts/set-public-inventory', { accountId: acc.id });
                successCount++;
                success = true;
              } catch (e) {
                const isTimeout = e.message?.includes('timeout') || e.response?.data?.error?.includes('超时');
                if (isTimeout && attempts < MAX_ATTEMPTS) {
                  console.warn(`[PublicInv] ${acc.name} 第 ${attempts} 次失败(超时)，正在进行第 ${attempts + 1} 次重试...`);
                  await new Promise(r => setTimeout(r, 2000)); // 等待 2s 后重试
                  continue;
                }
                console.error(`Set public inventory failed for ${acc.name} after ${attempts} attempts:`, e);
                break;
              }
            }
            // 每个 worker 处理完后稍微停一下
            await new Promise(r => setTimeout(r, 500));
          }
        })()
      );

      await Promise.all(workers);
      
      addNotification({ title: '批量设置完成', message: `成功公开了 ${successCount} 个账号的库存。`, type: 'success' });
      return;
    }

    if (!window.confirm(`确认要将账号 ${name} 的库存设为完全公开吗？`)) return;
    try {
      addNotification({ title: '正在设置', message: `正在公开 ${name} 的库存...`, type: 'info' });
      await api.post('accounts/set-public-inventory', { accountId: id });
      addNotification({ title: '设置成功', message: `${name} 的库存已公开`, type: 'success' });
    } catch (e) {
      console.error('Set public inventory failed:', e);
      addNotification({ title: '设置失败', message: e.response?.data?.error || e.message, type: 'error' });
    }
  };

  // Leaderboard Computation
  const leaderboardBase = (trackedItems || []).filter(i => {
    // Ranking Exclusion Filter
    if (i.excludeFromRanking) return false;

    const hasPrice = i.steamPrices?.CNY && i.lastC5Price && i.lastC5Price !== 'N/A';
    if (!hasPrice) return false;

    // StatTrak Filter (Persistent setting for Sidebars & Push)
    const isStatTrak = i.hashName.includes('StatTrak™');
    if (settings.showStatTrak === false && isStatTrak) return false;

    // Price Filter
    const p = parseFloat(i.lastC5Price);
    if (settings.rankingMinPrice && p < parseFloat(settings.rankingMinPrice)) return false;
    if (settings.rankingMaxPrice && p > parseFloat(settings.rankingMaxPrice)) return false;

    return true;
  });

  const cashOutTop = [...leaderboardBase].sort((a, b) => {
    const ra = parseFloat(getRatio(a.steamPrices?.CNY, a.lastC5Price));
    const rb = parseFloat(getRatio(b.steamPrices?.CNY, b.lastC5Price));
    return rb - ra; // Large to small (Best for cash-out)
  }).slice(0, 20);

  const topUpTop = [...leaderboardBase].sort((a, b) => {
    const ra = parseFloat(getRatio(a.steamPrices?.CNY, a.lastC5Price));
    const rb = parseFloat(getRatio(b.steamPrices?.CNY, b.lastC5Price));
    return ra - rb; // Small to large (Best for topping up)
  }).slice(0, 20);

  const handleSaveAlert = async (item, min, max, minRatio, maxRatio) => {
    try {
      const res = await api.post('tracked/alert', {
        hashName: item.hashName,
        minAlert: min || null,
        maxAlert: max || null,
        minRatioAlert: minRatio || null,
        maxRatioAlert: maxRatio || null
      });
      if (res.status === 200) {
        fetchTracked();
        setIsAlertModalOpen(false);
      } else {
        alert('保存预警失败');
      }
    } catch (e) {
      console.error('Save alert failed:', e);
      alert('网络错误，保存失败');
    }
  };

  const handleManualUpdate = async (seriesBaseName) => {
    if (updatingSeries.has(seriesBaseName)) return;

    setUpdatingSeries(prev => new Set(prev).add(seriesBaseName));
    try {
      const res = await api.post('tracked/update-series', { baseName: seriesBaseName });
      if (res.status === 200) {
        await fetchTracked();
      } else {
        const errData = res.data;
        alert(`更新失败: ${errData.error || '未知错误'}`);
      }
    } catch (e) {
      console.error('Manual update failed', e);
      if (e.response && e.response.status === 401) {
        // Interceptor should already show login box, but we can add a specific alert
        alert('认证失败：请验证密码并刷新页面');
      } else {
        alert(`手动更新连接失败: ${e.message}`);
      }
    } finally {
      setUpdatingSeries(prev => {
        const next = new Set(prev);
        next.delete(seriesBaseName);
        return next;
      });
    }
  };

  const getSteamDisplay = (item) => {
    if (!item.steamPrices) return item.lastSteamPrice || 'N/A';
    const active = settings.activeCurrencies;
    return active.map(code => item.steamPrices[code] || 'N/A').join(' / ');
  };

  const formatTime = (isoString) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const calculateDiffInternal = (steamCNY, c5Price) => {
    if (!steamCNY || !c5Price || c5Price === 'N/A') return null;
    const s = parseFloat(steamCNY.replace(/[^\d.]/g, ''));
    const y = parseFloat(c5Price);
    if (isNaN(s) || isNaN(y) || s === 0) return null;
    const diff = (s - y).toFixed(2);
    const percent = ((s - y) / y * 100).toFixed(1);
    return { value: diff, percent, isProfit: s > y };
  };

  if (requiresLogin) {
    return (
      <div className="login-overlay">
        <div className="login-box">
          <h2>🔒 安全校验</h2>
          <p>当前网站受管理员密码保护，请输入访问密码</p>
          <input
            type="password"
            placeholder="请输入密码"
            value={passwordInput}
            onChange={e => setPasswordInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
          />
          <button className="primary-btn" onClick={handleLogin}>进入系统</button>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileView
        trackedItems={trackedItems}
        cashOutTop={cashOutTop}
        topUpTop={topUpTop}
        seriesResults={seriesResults}
        steamAccounts={steamAccounts}
        activeAccountId={activeAccountId}
        setActiveAccountId={setActiveAccountId}
        settings={settings}
        setSettings={setSettings}
        updateSettings={updateSettings}
        inventorySummary={inventorySummary}
        handleManualUpdate={handleManualUpdate}
        handleDeleteSeries={handleDeleteSeries}
        removeFromTracked={removeFromTracked}
        handleToggleExcludeSeries={handleToggleExcludeSeries}
        handleSeriesIntervalChange={handleSeriesIntervalChange}
        handleMoveSeries={handleMoveSeries}
        handleSearch={fetchPrices}
        addTrack={addTrack}
        addBatchToTrack={addBatchToTrack}
        handleLogin={handleLogin}
        requiresLogin={requiresLogin}
        passwordInput={passwordInput}
        setPasswordInput={setPasswordInput}
        syncWealth={syncWealth}
        notifications={notifications}
        removeNotification={removeNotification}
        updatingSeries={updatingSeries}
        isSyncing={isSyncing}
        loading={loading}
        error={error}
        item={item}
        setItem={setItem}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        viewingAccountName={viewingAccountName}
        // New Props for Feature Parity
        isInventoryModalOpen={isInventoryModalOpen}
        setIsInventoryModalOpen={setIsInventoryModalOpen}
        inventoryData={inventoryData}
        inventoryLoading={inventoryLoading}
        fetchInventory={fetchInventory}
        fetchInventorySummary={fetchInventorySummary}
        isAccountModalOpen={isAccountModalOpen}
        setIsAccountModalOpen={setIsAccountModalOpen}
        addAccount={addAccount}
        updateAccount={updateAccount}
        deleteAccount={deleteAccount}
        isAlertModalOpen={isAlertModalOpen}
        setIsAlertModalOpen={setIsAlertModalOpen}
        alertItem={alertItem}
        setAlertItem={setAlertItem}
        handleSaveAlert={handleSaveAlert}
        isAlertManagerOpen={isAlertManagerOpen}
        setIsAlertManagerOpen={setIsAlertManagerOpen}
        isBatchSellModalOpen={isBatchSellModalOpen}
        setIsBatchSellModalOpen={setIsBatchSellModalOpen}
        openSellDialog={openSellDialog}
        confirmSell={confirmSell}
        sellDialog={sellDialog}
        setSellDialog={setSellDialog}
        isSelling={isSelling}
        sellSellerPrice={sellSellerPrice}
        sellBuyerPrice={sellBuyerPrice}
        handleSellerPriceChange={handleSellerPriceChange}
        handleBuyerPriceChange={handleBuyerPriceChange}
        sellQuantity={sellQuantity}
        setSellQuantity={setSellQuantity}
        marketPriceInfo={marketPriceInfo}
        selectedInterval={selectedInterval}
        setSelectedInterval={setSelectedInterval}
        selectedHashNames={selectedHashNames}
        setSelectedHashNames={setSelectedHashNames}
        showSearchStatTrak={showSearchStatTrak}
        setShowSearchStatTrak={setShowSearchStatTrak}
        searchMinPrice={searchMinPrice}
        setSearchMinPrice={setSearchMinPrice}
        searchMaxPrice={searchMaxPrice}
        setSearchMaxPrice={setSearchMaxPrice}
        saveDingTalkSettings={saveDingTalkSettings}
        testDingTalk={testDingTalk}
        dingTalkWebhookInput={dingTalkWebhookInput}
        setDingTalkWebhookInput={setDingTalkWebhookInput}
        dingTalkSecretInput={dingTalkSecretInput}
        setDingTalkSecretInput={setDingTalkSecretInput}
        steamCookieInput={steamCookieInput}
        setSteamCookieInput={setSteamCookieInput}
        dingTalkSaving={dingTalkSaving}
        handleBatchSell={async (accountId, items) => {
          try {
            const res = await api.post(`/accounts/${accountId}/batch-sell`, { items });
            return res.data;
          } catch (e) {
            console.error('Batch sell error:', e);
            throw e;
          }
        }}
        steamBuyerToSellerFen={steamBuyerToSellerFen}
        steamSellerToBuyerFen={steamSellerToBuyerFen}
        api={api}
      />
    );
  }

  return (
    <div className="container">
      <header className="header">
        <div className="header-top">
          <div className="settings-bar two-rows">
            <div className="settings-row row-primary">
              <div className="account-selector">
                <CustomSelect
                  labelPrefix="Steam 账号:"
                  value={activeAccountId}
                  options={steamAccounts.map(acc => ({ value: acc.id, label: acc.name }))}
                  onChange={val => setActiveAccountId(val)}
                />
                <button className="manage-acc-btn" onClick={() => setIsAccountModalOpen(true)}>管理</button>
                {(() => {
                  const activeAcc = steamAccounts.find(a => a.id === activeAccountId);
                  if (!activeAcc) return null;
                  return (
                    <div className="active-account-wealth">
                      <span className="wealth-item balance">{activeAcc.balance || '¥ 0.00'}</span>
                      <span className="wealth-divider">|</span>
                      <span
                        className="wealth-item inventory inventory-link"
                        onClick={() => fetchInventory(activeAcc.id, activeAcc.name)}
                        title="点击查看详细库存列表"
                      >
                        {activeAcc.inventoryValue || '0 件饰品'}
                      </span>
                    </div>
                  );
                })()}
              </div>
              <div className="settings-group push-ranking-group">
                <div className="push-ranking-row">
                  <span title="定时将换现金榜前5名推送到钉钉群">推送现金榜:</span>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.pushRankingEnabled}
                      onChange={(e) => updateSettings({ pushRankingEnabled: e.target.checked })}
                    /> 开启
                  </label>
                  <span style={{ marginLeft: '12px' }} title="定时将换余额榜前5名推送到钉钉群">推送余额榜:</span>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.pushTopUpEnabled}
                      onChange={(e) => updateSettings({ pushTopUpEnabled: e.target.checked })}
                    /> 开启
                  </label>
                </div>
                {(settings.pushRankingEnabled || settings.pushTopUpEnabled) && (
                  <div className="push-interval-options">
                    {[10, 20, 30].map(m => (
                      <button
                        key={m}
                        className={`push-interval-btn ${settings.pushRankingInterval === m * 60000 ? 'active' : ''}`}
                        onClick={() => updateSettings({ pushRankingInterval: m * 60000 })}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="settings-group" style={{ marginLeft: '4px', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '8px' }}>
                <span style={{ fontSize: '0.8rem' }}>自购:</span>
                <label className="checkbox-label" title="开启后，若推送比例满足条件则自动下单">
                  <input
                    type="checkbox"
                    checked={settings.autoBuyEnabled}
                    onChange={(e) => updateSettings({ autoBuyEnabled: e.target.checked })}
                  /> 开启
                </label>
                <span style={{ fontSize: '0.7rem', opacity: 0.8, marginLeft: '4px' }}>比例 &gt;</span>
                <input
                  type="number" step="0.01"
                  value={settings.autoBuyRatio}
                  onChange={(e) => updateSettings({ autoBuyRatio: e.target.value })}
                  style={{ width: '70px', fontSize: '0.75rem', padding: '4px 4px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)', textAlign: 'center' }}
                />
              </div>
              <div className="header-action-buttons">
                <button className="settings-btn" onClick={() => fetchTotalInventory()} style={{ padding: '4px 8px', fontSize: '0.75rem', width: '100%' }}>
                  📦 总库存
                </button>
                <button className="settings-btn" onClick={() => setIsAlertManagerOpen(true)} style={{ padding: '4px 8px', fontSize: '0.75rem', width: '100%' }}>
                  🔔 预警
                </button>
                <button className="settings-btn" onClick={() => setIsSettingsModalOpen(true)} style={{ padding: '4px 8px', fontSize: '0.75rem', width: '100%' }}>
                  ⚙️ 设置
                </button>
              </div>
            </div>

            <div className="settings-row row-dedupe">
              <div className="settings-group">
                <span style={{ fontSize: '0.8rem', color: '#818cf8', fontWeight: 'bold' }}>去重:</span>
                <label className="checkbox-label" title="开启后，同品类饰品在设定时间(h)内不会重复购买">
                  <input
                    type="checkbox"
                    checked={settings.autoBuyDedupeEnabled !== false}
                    onChange={(e) => updateSettings({ autoBuyDedupeEnabled: e.target.checked })}
                  /> 忽略同品类
                </label>
                <div style={{ display: 'flex', alignItems: 'center', marginLeft: '12px' }}>
                  <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>锁定时长:</span>
                  <input
                    type="number"
                    value={settings.autoBuyDedupeHours || 6}
                    onChange={(e) => updateSettings({ autoBuyDedupeHours: e.target.value })}
                    style={{ width: '45px', fontSize: '0.75rem', padding: '2px 4px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)', textAlign: 'center', marginLeft: '4px' }}
                  />
                  <span style={{ fontSize: '0.7rem', opacity: 0.8, marginLeft: '2px' }}>h</span>
                </div>
              </div>
            </div>

            <div className="settings-row row-secondary">
              <div className="settings-group">
                <span>排行榜:</span>
                <input
                  type="number"
                  placeholder="最低价"
                  value={settings.rankingMinPrice}
                  onChange={(e) => updateSettings({ rankingMinPrice: e.target.value })}
                  style={{ width: '70px', fontSize: '0.75rem', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}
                />
                <span>-</span>
                <input
                  type="number"
                  placeholder="最高价"
                  value={settings.rankingMaxPrice}
                  onChange={(e) => updateSettings({ rankingMaxPrice: e.target.value })}
                  style={{ width: '70px', fontSize: '0.75rem', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}
                />
                <label className="checkbox-label" style={{ marginLeft: '8px', fontSize: '0.8rem' }}>
                  <input
                    type="checkbox"
                    checked={settings.showStatTrak !== false}
                    onChange={e => updateSettings({ showStatTrak: e.target.checked })}
                  /> 暗金
                </label>
              </div>
              <div className="settings-group">
                <span>推送比例:</span>
                <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>现金 &gt;</span>
                <input
                  type="number" step="0.01"
                  value={settings.pushRankingCashThreshold}
                  onChange={(e) => updateSettings({ pushRankingCashThreshold: e.target.value })}
                  style={{ width: '85px', fontSize: '0.75rem', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)', textAlign: 'center' }}
                />
                <span style={{ fontSize: '0.7rem', opacity: 0.8, marginLeft: '8px' }}>余额 &lt;</span>
                <input
                  type="number" step="0.01"
                  value={settings.pushRankingTopUpThreshold}
                  onChange={(e) => updateSettings({ pushRankingTopUpThreshold: e.target.value })}
                  style={{ width: '85px', fontSize: '0.75rem', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)', textAlign: 'center' }}
                />
              </div>

              <div className="settings-group">
                <span>显示:</span>
                <label className="checkbox-label">
                  <input type="checkbox" checked={settings.showCashOut} onChange={(e) => updateSettings({ showCashOut: e.target.checked })} /> 换现金
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={settings.showTopUp} onChange={(e) => updateSettings({ showTopUp: e.target.checked })} /> 换余额
                </label>
              </div>
            </div>
          </div>
        </div>
      </header>


      {/* ── 主 Tab 导航 ── */}
      <div className="main-page-tabs">
        <button
          id="tab-tracking"
          className={`main-tab-btn ${mainPageTab === 'tracking' ? 'active' : ''}`}
          onClick={() => setMainPageTab('tracking')}
        >
          📊 饰品追踪
        </button>
        <button
          id="tab-account-mgmt"
          className={`main-tab-btn ${mainPageTab === 'account-mgmt' ? 'active' : ''}`}
          onClick={() => { setMainPageTab('account-mgmt'); if (!c5Balance) fetchC5Balance(); }}
        >
          🏦 账户管理
        </button>
      </div>

      {mainPageTab === 'tracking' && <>

        <div className="search-box">
          <input
            type="text"
            placeholder="输入系列或项名 (如: AK-47 | Slate 或 Inheritance)"
            value={item}
            onChange={(e) => setItem(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && fetchPrices()}
          />
          <CustomSelect
            labelPrefix="频率:"
            value={selectedInterval}
            options={[
              { value: 10, label: '10m' },
              { value: 20, label: '20m' },
              { value: 30, label: '30m' },
              { value: 60, label: '60m' }
            ]}
            onChange={val => setSelectedInterval(val)}
            className="search-interval-select"
          />
          <button onClick={fetchPrices}>搜索饰品</button>
        </div>

        {loading && <div className="loading">正在处理数据...</div>}

        {error && <div className="error">{error}</div>}

        {/* Batch Result View */}
        {seriesResults.length > 0 && !loading && (
          <div className="series-card fadeIn">
            <div className="series-header">
              <h3>找到 {seriesResults.filter(r => showSearchStatTrak || !r.hash_name.includes('StatTrak™')).length} 个版本 ({settings.activeCurrencies[0]} 实时)</h3>
              <div className="series-actions">
                <button
                  className={`secondary-btn ${!showSearchStatTrak ? 'active-filter' : ''}`}
                  onClick={() => setShowSearchStatTrak(!showSearchStatTrak)}
                >
                  {showSearchStatTrak ? '隐藏暗金 (StatTrak™)' : '显示所有版本'}
                </button>
                <button className="secondary-btn" onClick={() => setSelectedHashNames(new Set())}>全不选</button>
                <button
                  className="secondary-btn"
                  onClick={() => {
                    const visible = seriesResults.filter(r => showSearchStatTrak || !r.hash_name.includes('StatTrak™'));
                    setSelectedHashNames(new Set(visible.map(r => r.hash_name)));
                  }}
                >
                  全选
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => {
                    const wears = ['(Factory New)', '(Minimal Wear)', '(Field-Tested)'];
                    const preference = seriesResults.filter(r => {
                      const isStatTrak = r.hash_name.includes('StatTrak™');
                      const hasWear = wears.some(w => r.hash_name.includes(w));
                      return !isStatTrak && hasWear;
                    });
                    setSelectedHashNames(new Set(preference.map(r => r.hash_name)));
                  }}
                >
                  偏好选择
                </button>
                <button className="primary-btn" onClick={addBatchToTrack}>批量加入追踪 ({selectedHashNames.size})</button>
              </div>
            </div>

            {/* In-Card Search Filter Bar */}
            <div className="search-filter-subbar">
              <div className="filter-group">
                <label className="checkbox-label">
                  <input type="checkbox" checked={showSearchStatTrak} onChange={e => setShowSearchStatTrak(e.target.checked)} /> 包含 StatTrak™ (暗金)
                </label>
              </div>
              <div className="filter-group price-range">
                <label>价格区间 (CNY):</label>
                <input type="number" placeholder="最低" value={searchMinPrice} onChange={e => setSearchMinPrice(e.target.value)} />
                <span>-</span>
                <input type="number" placeholder="最高" value={searchMaxPrice} onChange={e => setSearchMaxPrice(e.target.value)} />
              </div>
              <button className="clear-filter-btn-small" onClick={() => { setSearchMinPrice(''); setSearchMaxPrice(''); setShowSearchStatTrak(true); }}>清除过滤</button>
            </div>
            <div className="series-grid">
              {seriesResults
                .filter(r => {
                  const isST = r.hash_name.includes('StatTrak™');
                  if (!showSearchStatTrak && isST) return false;
                  const pMatch = r.price ? parseFloat(r.price.replace(/[^\d.]/g, '')) : 0;
                  if (searchMinPrice && pMatch < parseFloat(searchMinPrice)) return false;
                  if (searchMaxPrice && pMatch > parseFloat(searchMaxPrice)) return false;
                  return true;
                })
                .map(r => (
                  <div
                    key={r.hash_name}
                    className={`series-item ${selectedHashNames.has(r.hash_name) ? 'selected' : ''}`}
                    onClick={() => toggleSelection(r.hash_name)}
                  >
                    <div className="item-select-hint">
                      <input type="checkbox" checked={selectedHashNames.has(r.hash_name)} readOnly />
                    </div>
                    {r.image && <img src={r.image} alt={r.hash_name} className="series-mini-img" />}
                    <div className="series-item-name">
                      <a
                        href={`https://steamcommunity.com/market/listings/730/${encodeURIComponent(r.hash_name)}`}
                        className="item-mini-link"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleOpenSteamMarket(r.hash_name); }}
                      >
                        {r.name}
                      </a>
                    </div>
                    <div className="series-item-price">{r.price}</div>
                    {r.c5Price && r.c5Price !== 'N/A' && (
                      <div className="series-item-c5price" style={{ fontSize: '0.75rem', color: '#a78bfa', marginTop: '2px' }}>
                        C5底价: ¥ {r.c5Price}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        )}
        {!loading && seriesResults.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '4rem' }}>
            <p>请输入物品名称并点击查找。</p>
          </div>
        )}

        {/* Dashboard Layout for Tracked Items */}

        {/* Dashboard Layout for Tracked Items */}
        <div className="dashboard-wrapper fadeIn">
          {settings.showCashOut && (
            <aside className="leaderboard-sidebar left" style={{ width: `${cashOutWidth}px` }}>
              <div className="resize-handle" onMouseDown={startResizing('left')}></div>
              <div className="leaderboard-header">换现金榜</div>
              <div className="leaderboard-list">
                {cashOutTop.map((item, idx) => (
                  <div key={item.hashName} className="leaderboard-item">
                    <span className="rank">{idx + 1}</span>
                    <div className="item-mini-info">
                      <a
                        href={`https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.hashName)}`}
                        className="item-mini-link"
                        onClick={(e) => { e.preventDefault(); handleOpenSteamMarket(item.hashName); }}
                        title={`使用账号 ${steamAccounts.find(a => a.id === activeAccountId)?.name} 打开`}
                      >
                        <div className="item-mini-name">{item.name || item.hashName}</div>
                      </a>
                      <div className="item-mini-val" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
                        <div style={{ color: 'var(--text-main)', opacity: 0.9 }}>比例: {getRatio(item.steamPrices?.CNY, item.lastC5Price)}</div>
                        <div className="mini-price-hint">Steam: {(item.steamPrices?.CNY || 'N/A').replace('≈', '')} | C5: ¥{item.lastC5Price}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {cashOutTop.length === 0 && <div className="empty-msg">暂无数据</div>}
              </div>
            </aside>
          )}
          <div className="tracked-section">
            <h2 className="section-title">自动化追踪列表</h2>
            <div className="series-cards-container">
              {Object.keys(groupedTracked).length === 0 ? (
                <p className="empty-msg">暂时没有追踪的物品</p>
              ) : (
                Object.entries(groupedTracked)
                  .map(([groupKey, subItems], idx, arr) => {
                    const sortedSubItems = [...subItems].sort((a, b) => {
                      if (sortConfig.key === 'ratio' && sortConfig.direction !== 'none') {
                        const rA = getBestRatioForGroup([a]);
                        const rB = getBestRatioForGroup([b]);
                        return sortConfig.direction === 'asc' ? rA - rB : rB - rA;
                      }
                      return 0;
                    });
                    const representative = sortedSubItems.find(i => i.image) || sortedSubItems[0];

                    // Derive Chinese title if possible from the first item's name
                    const displayTitle = (sortedSubItems[0].name || groupKey)
                      .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
                      .replace(/\s*[（\(].*?[）\)]\s*$/, '');

                    const isExpanded = expandedSeries.has(groupKey);

                    return (
                      <div key={groupKey} className={`tracked-series-card ${isExpanded ? 'active' : ''}`}>
                        <div className="series-card-main" onClick={() => toggleSeries(groupKey)}>
                          <div className="series-image-slot">
                            {representative.image ? <img src={representative.image} alt={displayTitle} /> : <div className="img-placeholder" />}
                          </div>
                          <div className="series-info">
                            <div className="series-title">{displayTitle}</div>
                            <div className="series-stats">
                              <span className="versions-info">包含 {subItems.length} 个版本</span>
                              <div className="timestamp-group">
                                <span className="timestamp-item">最近: {formatTime(subItems[0].lastUpdated)}</span>
                                <span className="timestamp-item">下次: {formatTime(subItems[0].nextUpdate)}</span>
                              </div>
                            </div>
                          </div>

                          {/* Inventory Summary (Red Box Area) */}
                          <div className="series-inventory-summary">
                            {sortedSubItems
                              .filter(subItem => inventorySummary[subItem.hashName] > 0)
                              .map(subItem => (
                                <div key={subItem.hashName} className="inventory-item-row-small">
                                  <span className="inv-count-badge">x{inventorySummary[subItem.hashName]}</span>
                                  <span className="inv-item-name-small">{subItem.name || subItem.hashName}</span>
                                  <div className="inv-item-prices-small">
                                    <span className="inv-p-youpin">C: ¥{subItem.lastC5Price}</span>
                                    <span className="inv-p-steam">S: {subItem.steamPrices?.CNY || 'N/A'}</span>
                                  </div>
                                </div>
                              ))}
                          </div>

                          <div className="series-controls" onClick={e => e.stopPropagation()}>
                            <div className="reorder-controls">
                              <button
                                className="reorder-btn up"
                                title="上移"
                                disabled={idx === 0}
                                onClick={() => handleMoveSeries(groupKey, 'up')}
                              >
                                ▲
                              </button>
                              <button
                                className="reorder-btn down"
                                title="下移"
                                disabled={idx === arr.length - 1}
                                onClick={() => handleMoveSeries(groupKey, 'down')}
                              >
                                ▼
                              </button>
                            </div>
                            <button
                              className={`update-series-btn ${updatingSeries.has(groupKey) ? 'updating' : ''}`}
                              onClick={() => handleManualUpdate(groupKey)}
                              disabled={updatingSeries.has(groupKey)}
                            >
                              {updatingSeries.has(groupKey) ? '更新中...' : '立即更新'}
                            </button>
                            <CustomSelect
                              labelPrefix="频率:"
                              value={subItems[0].interval || 30}
                              options={[
                                { value: 10, label: '10m' },
                                { value: 20, label: '20m' },
                                { value: 30, label: '30m' },
                                { value: 60, label: '60m' }
                              ]}
                              onChange={val => handleSeriesIntervalChange(groupKey, val)}
                              className="table-interval-select"
                            />
                            <label className="ranking-exclude-toggle" onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={!subItems.some(i => i.excludeFromRanking)}
                                onChange={(e) => handleToggleExcludeSeries(groupKey, !e.target.checked)}
                                onClick={e => e.stopPropagation()}
                              />
                              <span>榜单</span>
                            </label>
                            <button
                              className="delete-series-btn"
                              onClick={() => handleDeleteSeries(groupKey, subItems.length)}
                              title="删除整个系列"
                            >
                              🗑️
                            </button>
                          </div>
                          <div className="expand-icon">{isExpanded ? '▲' : '▼'}</div>
                        </div>

                        {isExpanded && (
                          <div className="series-details fadeIn">
                            <table className="tracked-table">
                              <thead>
                                <tr>
                                  <th>具体型号</th>
                                  <th>Steam ({settings.activeCurrencies.join(' / ')})</th>
                                  <th>C5底价</th>
                                  <th>差价 (利润%)</th>
                                  <th
                                    className="sortable-header"
                                    onClick={() => toggleSort()}
                                  >
                                    换现金
                                    <span className={`sort-icon ${sortConfig.direction}`}>
                                      {sortConfig.direction === 'asc' ? '▽' : (sortConfig.direction === 'desc' ? '△' : '▽')}
                                    </span>
                                  </th>

                                  <th>榜单</th>
                                  <th>移除</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sortedSubItems.map(ti => {
                                  const steamPriceCNY = ti.steamPrices?.CNY;
                                  const d = calculateDiffInternal(steamPriceCNY, ti.lastC5Price);
                                  return (
                                    <tr key={ti.hashName}>
                                      <td>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                          <button
                                            className={`alert-toggle-btn ${(ti.minAlert || ti.maxAlert || ti.minRatioAlert || ti.maxRatioAlert) ? 'active' : ''}`}
                                            onClick={() => { setAlertItem(ti); setIsAlertModalOpen(true); }}
                                            title="点此设置价格波动预警"
                                          >
                                            🔔
                                          </button>
                                          <a
                                            href={`https://steamcommunity.com/market/listings/730/${encodeURIComponent(ti.hashName)}`}
                                            className="inventory-item-link"
                                            onClick={(e) => { e.preventDefault(); handleOpenSteamMarket(ti.hashName); }}
                                          >
                                            {ti.name || ti.hashName}
                                          </a>
                                        </div>
                                      </td>
                                      <td className="steam-price">{getSteamDisplay(ti)}</td>
                                      <td className="youpin-price">¥ {ti.lastC5Price || 'N/A'}</td>
                                      <td className={d?.isProfit ? 'profit-text' : 'loss-text'}>
                                        {d ? `¥ ${d.value} (${d.percent}%)` : 'N/A'}
                                      </td>
                                      <td className="ratio-cell">
                                        {getRatio(ti.steamPrices?.CNY, ti.lastC5Price) || 'N/A'}
                                      </td>

                                      <td>
                                        <input
                                          type="checkbox"
                                          checked={!ti.excludeFromRanking}
                                          onChange={() => handleToggleExcludeItem(ti.hashName, ti.excludeFromRanking)}
                                        />
                                      </td>
                                      <td>
                                        <button className="remove-btn-small" onClick={() => removeFromTracked(ti.hashName)}>×</button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
          {settings.showTopUp && (
            <aside className="leaderboard-sidebar right" style={{ width: `${topUpWidth}px` }}>
              <div className="resize-handle" onMouseDown={startResizing('right')}></div>
              <div className="leaderboard-header">换余额榜</div>
              <div className="leaderboard-list">
                {topUpTop.map((item, idx) => (
                  <div key={item.hashName} className="leaderboard-item">
                    <span className="rank">{idx + 1}</span>
                    <div className="item-mini-info">
                      <div
                        className="item-mini-link"
                        onClick={() => {
                          const activeAcc = steamAccounts.find(a => a.id === activeAccountId) || steamAccounts[0];
                          const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.hashName)}`;
                          handleOpenBrowser(url, activeAcc.browserPath, activeAcc.profile, activeAcc.browserType, activeAcc.profilePath);
                        }}
                        title={`使用账号 ${steamAccounts.find(a => a.id === activeAccountId)?.name} 打开`}
                      >
                        <div className="item-mini-name">{item.name || item.hashName}</div>
                      </div>
                      <div className="item-mini-val" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
                        <div style={{ color: 'var(--text-main)', opacity: 0.9 }}>比例: {getRatio(item.steamPrices?.CNY, item.lastC5Price)}</div>
                        <div className="mini-price-hint">Steam: {(item.steamPrices?.CNY || 'N/A').replace('≈', '')} | C5: ¥{item.lastC5Price}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {topUpTop.length === 0 && <div className="empty-msg">暂无数据</div>}
              </div>
            </aside>
          )}
        </div>

        {false && isAccountModalOpen && (
          <div className="modal-overlay" onClick={() => setIsAccountModalOpen(false)}>
            <div className="modal-content glass-effect" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Steam 账号管理</h3>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    className="sync-all-btn"
                    onClick={syncAllAccounts}
                    disabled={isSyncing}
                    style={{
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      background: 'var(--accent-color)',
                      color: '#000',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      opacity: isSyncing ? 0.6 : 1
                    }}
                  >
                    {isSyncing ? '同步处理中...' : '一键同步所有账号'}
                  </button>

                  <button className="close-btn" onClick={() => setIsAccountModalOpen(false)}>×</button>
                </div>
              </div>
              <div className="account-list-editor">
                {steamAccounts.map(acc => (
                  <div className="account-edit-row" key={acc.id}>
                    <div className="edit-main-fields" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="edit-field-group">
                          <label>账号名称:</label>
                          <input
                            value={acc.name}
                            placeholder="例如: 大号 / 刷箱号"
                            onChange={e => updateAccount(acc.id, 'name', e.target.value)}
                          />
                        </div>
                        <div className="edit-field-group">
                          <label>SteamID64 (可选):</label>
                          <input
                            value={acc.steamId64 || ''}
                            placeholder="同步时可自动查找"
                            onChange={e => updateAccount(acc.id, 'steamId64', e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="edit-field-group">
                        <label style={{ display: 'block', color: '#c084fc', fontWeight: 'bold', marginBottom: '4px' }}>🔗 关联 C5 商户 (API Key):</label>
                        <CustomSelect
                          value={acc.c5MerchantId || ''}
                          options={[
                            { label: '--- 未绑定 (使用系统默认) ---', value: '' },
                            ...merchants.map(m => ({ label: m.isDefault ? `⭐ ${m.name} (默认)` : m.name, value: m.id }))
                          ]}
                          onChange={(val) => updateAccount(acc.id, 'c5MerchantId', val || null)}
                          className="full-width"
                        />
                      </div>
                      <div className="edit-field-group" style={{ flex: 1 }}>
                        <label>账号 Steam Cookie (用于购买功能):</label>
                        <input
                          type="password"
                          value={acc.steamCookie || ''}
                          placeholder="粘贴账号专用的 Steam Cookie，否则将无法使用此账号购买"
                          onChange={e => updateAccount(acc.id, 'steamCookie', e.target.value)}
                          style={{ width: '100%', fontFamily: 'monospace' }}
                        />
                      </div>
                    </div>

                    <div className="account-wealth-status">
                      <div className="wealth-item">钱包余额: <span>{acc.balance || '¥ 0.00'}</span></div>
                      <div className="wealth-item">
                        库存估算:
                        <span
                          className="inventory-link"
                          onClick={() => fetchInventory(acc.id, acc.name)}
                          title="点击查看详细库存列表"
                        >
                          {acc.inventoryValue || '¥ 0.00'}
                        </span>
                      </div>
                      <div className="wealth-item" style={{ fontSize: '0.85rem' }}>
                        已上架:
                        <span
                          className="inventory-link"
                          onClick={() => fetchMarketListings(acc.id, acc.name)}
                          style={{ marginLeft: '4px' }}
                          title="查看正在出售中的饰品"
                        >
                          查询挂单
                        </span>
                      </div>
                      {acc.lastSync && (
                        <div className="wealth-item" style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                          上次同步: {new Date(acc.lastSync).toLocaleString()}
                        </div>
                      )}
                    </div>

                    <div className="account-row-actions">
                      <button
                        className="secondary-btn"
                        style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
                        title="打开独立沙盒窗口进行登录"
                        onClick={() => handleOpenBrowser('https://store.steampowered.com/login/', acc.browserPath, acc.profile, acc.browserType, acc.profilePath)}
                      >
                        点击登录账号
                      </button>
                      <button
                        className={`sync-wealth-btn ${isSyncing && activeAccountId === acc.id ? 'syncing' : ''}`}
                        onClick={() => syncWealth(acc.id)}
                        disabled={isSyncing}
                      >
                        {isSyncing && activeAccountId === acc.id ? '正在同步...' : '同步资产数据'}
                      </button>
                      <button className="delete-acc-btn" onClick={() => deleteAccount(acc.id)}>删除</button>
                    </div>
                  </div>
                ))}
                <button className="add-acc-btn" onClick={addAccount}>+ 添加账号</button>
                <div className="profile-hint-box">
                  <p>💡 提示：点击“登录账号”即可在独立沙盒窗口中登录 Steam，互不串号。</p>
                </div>
              </div>
              <div className="modal-footer">
                <button className="primary-btn" onClick={() => setIsAccountModalOpen(false)}>完成</button>
              </div>
            </div>
          </div>
        )}
        {isInventoryModalOpen && (
          <div className="modal-overlay" onClick={() => setIsInventoryModalOpen(false)}>
            <div className="modal-content inventory-modal glass-effect" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{viewingAccountName} - 库存详情</h3>
                <button className="close-btn" onClick={() => setIsInventoryModalOpen(false)}>×</button>
              </div>
              <div className="inventory-list-container">
                {inventoryLoading ? (
                  <div className="loading-spinner">正在加载大批量库存档案...</div>
                ) : inventoryData ? (
                  <div className="inventory-grid">
                    {(() => {
                      // Build classid_instanceid -> assetid lookup from assets array
                      const assetMap = new Map();
                      if (!inventoryData.isTotalView && inventoryData.assets) {
                        inventoryData.assets.forEach(a => {
                          const key = `${a.classid}_${a.instanceid}`;
                          if (!assetMap.has(key)) assetMap.set(key, []);
                          assetMap.get(key).push(a.assetid);
                        });
                      }
                      return inventoryData.descriptions
                        .filter(item => {
                          if (inventoryData.isTotalView) return true;
                          const nameStr = item.market_bucket_group_name || item.name || item.market_name || '';
                          return !nameStr.includes('挂件拆卸器包') && !nameStr.includes('涂鸦') && item.marketable === 1;
                        })
                        .map((item, idx) => {
                          const assetids = assetMap.get(`${item.classid}_${item.instanceid}`) || [];
                          const ownedQty = assetids.length || (item.totalCount || 0);
                          return (
                            <div className="inventory-item-card" key={idx}>
                              {ownedQty > 1 && <div className="total-count-badge">x{ownedQty}</div>}
                              <div className="item-img-box">
                                <img
                                  src={`https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/96fx96f`}
                                  alt={item.market_hash_name}
                                />
                              </div>
                              <div className="item-details">
                                <div
                                  className="item-name inventory-item-link"
                                  title={item.market_name}
                                  onClick={() => handleOpenSteamMarket(item.market_hash_name)}
                                >
                                  {(() => {
                                    const exteriorObj = item.descriptions?.find(d => typeof d.value === 'string' && d.value.includes('外观：'));
                                    const wearText = exteriorObj ? `(${exteriorObj.value.slice(-4)})` : null;
                                    const baseName = item.market_bucket_group_name || item.name || item.market_name;
                                    return (
                                      <>
                                        <span className="base-name" title={baseName}>{baseName}</span>
                                        {wearText && <span className="wear-text">{wearText}</span>}
                                      </>
                                    );
                                  })()}
                                </div>
                                <div
                                  className="item-type"
                                  style={{ color: getRarityInfo(item.type).color, fontWeight: 'bold' }}
                                >
                                  {getRarityInfo(item.type).label}
                                </div>
                                {!inventoryData.isTotalView && assetids.length > 0 && item.marketable === 1 && (
                                  <button
                                    className="sell-btn"
                                    onClick={() => openSellDialog(item, assetids)}
                                    title={`上架到 Steam 市场（拥有 ${assetids.length} 个）`}
                                  >
                                    {'\uD83D\uDCB0'} 上架 {assetids.length > 1 ? `(×${assetids.length})` : ''}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        });
                    })()}
                  </div>
                ) : (
                  <div className="empty-inventory">暂无库存数据，请先尝试“同步资产数据”。</div>
                )}
              </div>
              <div className="modal-footer">
                <button className="primary-btn" onClick={() => setIsInventoryModalOpen(false)}>关闭</button>
              </div>
            </div>
          </div>
        )}
        {/* Sell Dialog */}
        {sellDialog && (
          <div className="modal-overlay" onClick={() => setSellDialog(null)}>
            <div className="modal-content glass-effect" style={{ maxWidth: '380px' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>💰 上架到 Steam 市场</h3>
                <button className="close-btn" onClick={() => setSellDialog(null)}>×</button>
              </div>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', wordBreak: 'break-word' }}>
                  <strong>{sellDialog.item.name || sellDialog.item.market_name}</strong>
                </div>
                {marketPriceInfo && (
                  <div style={{
                    fontSize: '0.78rem', borderRadius: '6px', padding: '6px 10px',
                    background: marketPriceInfo.loading ? 'rgba(255,255,255,0.05)' : 'rgba(80,200,255,0.08)',
                    color: marketPriceInfo.error ? 'var(--text-muted)' : 'var(--accent-cyan)',
                    border: '1px solid rgba(80,200,255,0.15)'
                  }}>
                    {marketPriceInfo.loading && '⏳ 正在查询市场价格...'}
                    {marketPriceInfo.error && `⚠️ ${marketPriceInfo.error}`}
                    {marketPriceInfo.lowest_price && (
                      <>
                        📊 市场最低价 <strong>{marketPriceInfo.lowest_price}</strong>
                        {marketPriceInfo.median_price && <> &nbsp;·&nbsp; 中位价 <strong>{marketPriceInfo.median_price}</strong></>}
                        {' '}（已自动填入）
                      </>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>到手价（不含手续费）</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>¥</span>
                    <input
                      type="number"
                      min="0.01" step="0.01"
                      value={sellSellerPrice}
                      onChange={e => handleSellerPriceChange(e.target.value)}
                      placeholder="到手价"
                      style={{ flex: 1, padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)', color: 'var(--text-primary)', fontSize: '1rem' }}
                      autoFocus
                    />
                  </div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>上架价格（+15% 手续费）</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>¥</span>
                    <input
                      type="number"
                      min="0.01" step="0.01"
                      value={sellBuyerPrice}
                      onChange={e => handleBuyerPriceChange(e.target.value)}
                      placeholder="上架价格"
                      style={{ flex: 1, padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)', color: 'var(--text-primary)', fontSize: '1rem' }}
                    />
                  </div>
                  {sellDialog?.assetids?.length > 1 && (
                    <>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>出售数量（拥有 {sellDialog.assetids.length} 个）</label>
                      <input
                        type="number"
                        min="1"
                        max={sellDialog.assetids.length}
                        step="1"
                        value={sellQuantity}
                        onChange={e => { const v = e.target.value; setSellQuantity(v === '' ? '' : Math.min(Math.max(1, parseInt(v) || 1), sellDialog.assetids.length)); }}
                        style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)', color: 'var(--text-primary)', fontSize: '1rem', width: '120px' }}
                      />
                    </>
                  )}
                </div>
                {sellSellerPrice && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent-cyan)', background: 'rgba(0,255,200,0.07)', borderRadius: '6px', padding: '6px 10px' }}>
                    ℹ️ 到手价为 <strong>¥{parseFloat(sellSellerPrice).toFixed(2)}</strong>，Steam 扣手续费 <strong>¥{(parseFloat(sellSellerPrice) * 0.15).toFixed(2)}</strong>。上架价格 <strong>¥{sellBuyerPrice}</strong>。
                    {parseInt(sellQuantity) > 1 && (<><br />共上架 <strong>{sellQuantity}</strong> 个，合计到账 <strong>¥{(parseFloat(sellSellerPrice) * parseInt(sellQuantity)).toFixed(2)}</strong>。</>)}
                  </div>
                )}
              </div>
              <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button className="secondary-btn" onClick={() => setSellDialog(null)} disabled={isSelling}>取消</button>
                <button className="primary-btn" onClick={confirmSell} disabled={isSelling || !sellSellerPrice || parseFloat(sellSellerPrice) <= 0}>
                  {isSelling ? '正在上架...' : '确认上架'}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Notification Toasts */}
        <div className="notification-container">
          {notifications.map(n => (
            <div key={n.id} className={`toast glass-effect ${n.type || ''} ${n.removing ? 'removing' : ''}`}>
              <button className="toast-close" onClick={() => removeNotification(n.id)}>×</button>
              <div className="toast-img">
                {n.image && <img src={n.image} alt="item" />}
              </div>
              <div className="toast-content">
                <div className="toast-title">{n.title}</div>
                <div className="toast-msg">{n.message}</div>
                <div className="toast-price-change">{n.price}</div>
                <div className="toast-time">{n.timestamp}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Alert Settings Modal */}
        {isAlertModalOpen && alertItem && (
          <div className="modal-overlay" onClick={() => setIsAlertModalOpen(false)}>
            <div className="modal-content glass-effect" style={{ maxWidth: '400px' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>价格预警设置</h3>
                <button className="close-btn" onClick={() => setIsAlertModalOpen(false)}>×</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  设置 <strong>{alertItem.name || alertItem.hashName}</strong> 的预警阈值
                </p>
                <div className="alert-form">
                  <div className="alert-section-title">💰 C5Game价格预警</div>
                  <div className="alert-input-group">
                    <label>最低价预警 (价格跌到此值以下触发):</label>
                    <input
                      type="number"
                      placeholder="例如: 100"
                      defaultValue={alertItem.minAlert || ''}
                      id="min-alert-input"
                    />
                  </div>
                  <div className="alert-input-group">
                    <label>最高价预警 (价格涨到此值以上触发):</label>
                    <input
                      type="number"
                      placeholder="例如: 500"
                      defaultValue={alertItem.maxAlert || ''}
                      id="max-alert-input"
                    />
                  </div>
                  <div className="alert-section-title" style={{ marginTop: '1rem' }}>📈 比例预警 (C5价 / Steam价)</div>
                  <div className="alert-input-group">
                    <label>比例下限 (比例小于此值触发，例: 0.650):</label>
                    <input
                      type="number"
                      step="0.001"
                      placeholder="例如: 0.650"
                      defaultValue={alertItem.minRatioAlert || ''}
                      id="min-ratio-input"
                    />
                  </div>
                  <div className="alert-input-group">
                    <label>比例上限 (比例大于此值触发，例: 0.800):</label>
                    <input
                      type="number"
                      step="0.001"
                      placeholder="例如: 0.800"
                      defaultValue={alertItem.maxRatioAlert || ''}
                      id="max-ratio-input"
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="secondary-btn" onClick={() => setIsAlertModalOpen(false)}>取消</button>
                <button className="primary-btn" onClick={async () => {
                  const min = document.getElementById('min-alert-input').value;
                  const max = document.getElementById('max-alert-input').value;
                  const minRatio = document.getElementById('min-ratio-input').value;
                  const maxRatio = document.getElementById('max-ratio-input').value;
                  handleSaveAlert(alertItem, min, max, minRatio, maxRatio);
                }}>保存设置</button>
              </div>
            </div>
          </div>
        )}

        {/* Alert Management Modal */}
        {isAlertManagerOpen && (
          <div className="modal-overlay" onClick={() => setIsAlertManagerOpen(false)}>
            <div className="modal-content glass-effect alert-manager-modal" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>🔔 预警管理中心</h3>
                <button className="close-btn" onClick={() => setIsAlertManagerOpen(false)}>×</button>
              </div>
              <div className="alert-manager-list custom-scrollbar">
                {trackedItems.filter(item => item.minAlert || item.maxAlert || item.minRatioAlert || item.maxRatioAlert).length > 0 ? (
                  trackedItems.filter(item => item.minAlert || item.maxAlert || item.minRatioAlert || item.maxRatioAlert).map(item => (
                    <div key={item.hashName} className="active-alert-item">
                      <div className="alert-item-img">
                        {item.image && <img src={item.image} alt="item" />}
                      </div>
                      <div className="alert-item-info">
                        <div className="alert-item-name">{item.name || item.hashName}</div>
                        <div className="alert-item-thresholds">
                          {item.minAlert && <span className="threshold-tag min">价格下限: ¥{item.minAlert}</span>}
                          {item.maxAlert && <span className="threshold-tag max">价格上限: ¥{item.maxAlert}</span>}
                          {item.minRatioAlert && <span className="threshold-tag min">比例下限: {item.minRatioAlert}</span>}
                          {item.maxRatioAlert && <span className="threshold-tag max">比例上限: {item.maxRatioAlert}</span>}
                        </div>
                      </div>
                      <div className="alert-item-actions">
                        <button
                          className="clear-alert-btn"
                          onClick={() => {
                            if (window.confirm(`确定要清除 "${item.name || item.hashName}" 的预警吗？`)) {
                              handleSaveAlert(item, '', '', '', '');
                            }
                          }}
                          title="清除预警"
                        >
                          🗑️ 清除
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-alerts">
                    <div style={{ fontSize: '3rem', marginBottom: '1rem', opacity: 0.3 }}>🔔</div>
                    <p>目前没有正在监控的价格预警</p>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="primary-btn" onClick={() => setIsAlertManagerOpen(false)}>关闭</button>
              </div>
            </div>
          </div>
        )}

        {/* Active Listings Modal */}
        {isListingsModalOpen && (
          <div className="modal-overlay" onClick={() => setIsListingsModalOpen(false)}>
            <div className="modal-content glass-effect" style={{ maxWidth: '700px', width: '90%' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>📦 {viewingAccountName} - 当前已上架饰品</h3>
                <button className="close-btn" onClick={() => setIsListingsModalOpen(false)}>×</button>
              </div>
              <div className="modal-body custom-scrollbar" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '1.2rem' }}>
                {listingsLoading ? (
                  <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <div style={{ width: '40px', height: '40px', border: '3px solid rgba(80,200,255,0.1)', borderTopColor: 'var(--accent-cyan)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 1.5rem auto' }}></div>
                    <p style={{ marginTop: '1rem' }}>正在从 Steam 实时加载上架清单...</p>
                  </div>
                ) : activeListings.length > 0 ? (
                  <>
                    <div className="listings-summary-header" style={{
                      background: 'rgba(80,200,255,0.06)',
                      padding: '1rem',
                      borderRadius: '12px',
                      marginBottom: '1.2rem',
                      border: '1px solid rgba(80,200,255,0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-around',
                      textAlign: 'center'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', marginRight: '1.2rem' }} onClick={toggleSelectAll}>
                          <input
                            type="checkbox"
                            checked={selectedListings.length === activeListings.length && activeListings.length > 0}
                            onChange={toggleSelectAll}
                            style={{ width: '18px', height: '18px', cursor: 'pointer', marginRight: '8px' }}
                          />
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>全选</span>
                        </div>
                        {selectedListings.length > 0 && (
                          <button
                            className="remove-listing-btn"
                            style={{
                              background: 'var(--loss-color)',
                              color: 'white',
                              border: 'none',
                              padding: '0.4rem 0.8rem',
                              animation: 'fadeIn 0.2s ease-out'
                            }}
                            onClick={handleBatchRemove}
                          >
                            批量下架 ({selectedListings.length})
                          </button>
                        )}
                      </div>
                      <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }}></div>
                      <div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>总上架项目</div>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--accent-cyan)' }}>{activeListings.length} 件</div>
                      </div>
                      <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }}></div>
                      <div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>预计总计到账</div>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--accent-cyan)' }}>
                          ¥ {(activeListings.reduce((sum, item) => sum + (item.sellerPrice || 0), 0) / 100).toFixed(2)}
                        </div>
                      </div>
                    </div>

                    <div className="active-listings-list">
                      {activeListings.map(listing => (
                        <div key={listing.listingId} className={`active-listing-row ${selectedListings.includes(listing.listingId) ? 'selected' : ''}`} onClick={() => toggleSelectListing(listing.listingId)}>
                          <div className="listing-checkbox-container" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedListings.includes(listing.listingId)}
                              onChange={() => toggleSelectListing(listing.listingId)}
                              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                            />
                          </div>
                          <div className="listing-img-container">
                            {listing.image && <img src={listing.image} alt={listing.name} />}
                          </div>
                          <div className="listing-main-info">
                            <div className="listing-item-name">{listing.name}</div>
                            <div className="listing-time-text">{listing.created} 上架</div>
                          </div>
                          <div className="listing-price-tag" title={`到手: ¥ ${(listing.sellerPrice / 100).toFixed(2)}\n手续费: ¥ ${(listing.fee / 100).toFixed(2)}`}>
                            {listing.priceText}
                          </div>
                          <button
                            className="remove-listing-btn"
                            onClick={(e) => { e.stopPropagation(); handleRemoveListing(listing.listingId); }}
                          >
                            下架
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '3rem', opacity: 0.5 }}>
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📦</div>
                    <p>该账号目前没有正在出售中的饰品</p>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="primary-btn" onClick={() => setIsListingsModalOpen(false)}>关闭</button>
              </div>
            </div>
          </div>
        )}

      </>}


      {/* ── 账户管理 Tab ── */}
      {mainPageTab === 'account-mgmt' && (
        <div className="c5-account-mgmt">

          {/* C5 余额头部 */}
          <div className="c5-balance-header" onClick={() => { setIsC5MatrixOpen(!isC5MatrixOpen); if (!isC5MatrixOpen) fetchC5BoundAccounts(); }} style={{ cursor: 'pointer' }}>
            <div className="c5-balance-title">
              <span className="c5-logo">C5</span>
              <span>{merchants.find(m => m.id === selectedMerchantId)?.name || 'C5'} 账户余额</span>
              <span style={{ fontSize: '0.8rem', marginLeft: '0.5rem', opacity: 0.6 }}>{isC5MatrixOpen ? '▲ 点击收起矩阵' : '▼ 点击展开账号矩阵'}</span>
            </div>
            {c5BalanceLoading ? (
              <div className="c5-balance-loading">加载中...</div>
            ) : c5Balance ? (
              <div className="c5-balance-values">
                <div className="c5-bal-main">
                  <span className="c5-bal-label">可用余额</span>
                  <span className="c5-bal-amount">¥ {parseFloat(c5Balance.moneyAmount || c5Balance.creditMoney || 0).toFixed(2)}</span>
                </div>
                {(c5Balance.depositAmount != null || c5Balance.creditDeposit != null) && (
                  <div className="c5-bal-sub">保证金: ¥ {parseFloat(c5Balance.depositAmount ?? c5Balance.creditDeposit).toFixed(2)}</div>
                )}
                {c5Balance.tradeSettleAmount != null && (
                  <div className="c5-bal-sub">待结算: ¥ {parseFloat(c5Balance.tradeSettleAmount).toFixed(2)}</div>
                )}
              </div>
            ) : (
              <div className="c5-balance-empty">暂无余额数据</div>
            )}
            <button
              className="c5-refresh-btn"
              onClick={(e) => { e.stopPropagation(); fetchC5Balance(selectedMerchantId); }}
              disabled={c5BalanceLoading}
            >
              {c5BalanceLoading ? '…' : '🔄 刷新'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
            <button className="c5-manage-merchants-btn" onClick={() => setIsMerchantManagerOpen(true)}>
              ⚙️ 管理 C5 商户 (API Key)
            </button>
          </div>

          {/* ─── C5 账号矩阵 ─── */}
          {isC5MatrixOpen && (
            <div className="c5-matrix-panel fadeIn">
              <div className="c5-matrix-header">
                <div className="c5-matrix-title">🌐 已绑定到 C5 的 Steam 账号 ({c5BoundAccounts.length})</div>
                <div className="c5-matrix-actions">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '15px' }}>
                    <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>当前商户:</span>
                    <CustomSelect
                      value={selectedMerchantId || ''}
                      options={merchants.map(m => ({ label: m.name + (m.isDefault ? ' (默认)' : ''), value: m.id }))}
                      onChange={(val) => {
                        setSelectedMerchantId(val);
                        fetchC5BoundAccounts(val);
                        fetchC5Balance(val);
                      }}
                      className="merchant-selector-mini"
                    />
                  </div>
                  <button className="c5-matrix-import-btn" onClick={() => setIsC5ImportModalOpen(true)}>
                    📥 导入 Steam 账号
                  </button>
                  <button className="c5-matrix-batch-bind-btn" onClick={() => { 
                    setIsC5BatchBindOpen(true); 
                    setC5BatchBindResults(null); 
                    setC5BatchBindSelected(new Set()); 
                    const defaultM = merchants.find(m => m.isDefault) || merchants[0];
                    const targetMId = selectedMerchantId || (defaultM ? defaultM.id : null);
                    setC5BatchBindMerchantId(targetMId);
                    const targetM = merchants.find(m => String(m.id) === String(targetMId));
                    setC5BatchBindPhone((targetM && targetM.phone) ? targetM.phone : '');
                  }}>
                    🔗 C5 批量绑定
                  </button>
                  <button className="c5-matrix-refresh-btn" onClick={() => fetchC5BoundAccounts(selectedMerchantId)} disabled={c5BoundLoading}>
                    {c5BoundLoading ? '同步中...' : '🔄 同步云端列表'}
                  </button>
                </div>
              </div>

              <div className="c5-matrix-grid">
                {c5BoundAccounts.length === 0 && !c5BoundLoading && (
                  <div className="c5-matrix-empty">暂无绑定账号，请使用批量导入或在 C5 官网手动添加</div>
                )}
                {c5BoundAccounts.map(acc => {
                  const localAcc = steamAccounts.find(a => a.steamId64 === acc.steamId);
                  return (
                    <div key={acc.steamId} className={`c5-matrix-card ${localAcc ? 'is-local' : 'not-local'}`}>
                      <div className="c5-mcard-top">
                        <span className="c5-mcard-name">{acc.personaName || '未命名'}</span>
                        <span className="c5-mcard-id">{acc.steamId}</span>
                      </div>
                      <div className="c5-mcard-status">
                        {localAcc ? (
                          <span className="status-tag local">✅ 本地已同步</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <span className="status-tag remote">☁️ 仅云端存在</span>
                            <button
                              className="c5-mini-sync-btn"
                              onClick={() => handleSyncToLocal(acc)}
                              title="点击同步到本地数据库"
                            >
                              同步本地
                            </button>
                          </div>
                        )}
                      </div>
                      {acc.tradeUrl && (
                        <div className="c5-mcard-url" title={acc.tradeUrl}>🔗 TradeURL 已就绪</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Steam 账号列表 — 分组折叠展开布局 */}
          <div className="c5-accounts-section">

            {/* 顶部操作栏 */}
            <div className="c5-accounts-toolbar">
              <button
                className="c5-batch-import-btn"
                onClick={() => setIsC5ImportModalOpen(true)}
                title="批量导入 maFile，自动建组"
              >
                📥 批量导入
              </button>
              <button
                className="c5-batch-password-btn"
                onClick={() => setIsBatchPasswordModalOpen(true)}
                title="批量导入账号密码（格式: 账号----密码），自动匹配数据库账号"
              >
                🔑 导入密码
              </button>
              <button
                className="c5-manage-groups-btn"
                onClick={() => setIsGroupManagerOpen(true)}
                title="管理分组"
              >⚙️ 分组管理</button>
              <button
                className="scanner-trigger-btn c5-red-letter-btn"
                onClick={() => setIsScannerModalOpen(true)}
                title="上传 maFile 文件进行精准红信(封禁)检测"
              >
                🔍 红信详细检测
              </button>
              <button
                className="c5-transfer-btn"
                onClick={() => setIsTransferModalOpen(true)}
                title="选择多个来源账号将 CS2 饰品批量转移到指定接收账号"
              >
                📦 库存转移
              </button>
              <button
                className="c5-confirm-btn"
                onClick={() => setIsConfirmModalOpen(true)}
                title="批量查看并用 TOTP 确认待处理交易"
              >
                🔑 令牌确认
              </button>
              <button
                className="c5-sync-personas-btn"
                onClick={syncPersonaNames}
                disabled={isSyncingPersonas}
                title="向 Steam 获取账号对外昵称（解决普通用户识别失败的问题）"
              >
                {isSyncingPersonas ? '🔄 正在同步...' : '🔄 同步昵称'}
              </button>
              
              <div style={{position: 'relative', display: 'flex', alignItems: 'stretch'}}>
                <select 
                  className="c5-sync-personas-btn"
                  title="选择账号以公开其库存"
                  onChange={(e) => {
                    if (e.target.value) {
                      setInventoryPublic(e.target.value, e.target.options[e.target.selectedIndex].text);
                      e.target.value = '';
                    }
                  }}
                  style={{appearance: 'none', paddingRight: '24px', cursor: 'pointer', paddingLeft: '12px', width: '120px', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}
                >
                  <option value="">🔓 公开库存 ▼</option>
                  <option value="ALL" style={{color: '#ff4444', fontWeight: 'bold'}}>一键公开所有账号</option>
                  {steamAccounts.filter(a => a.mafileContent).map(a => (
                     <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <div style={{position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '0.6rem'}}></div>
              </div>
              <div className="c5-accounts-count" style={{ marginLeft: 'auto' }}>共 {steamAccounts.length} 个账号</div>
            </div>

            {/* 分组折叠展开布局 */}
            {(() => {
              const grouped = groups.map(g => ({
                ...g,
                accounts: steamAccounts.filter(a => String(a.groupId) === String(g.id))
              }));
              const ungrouped = steamAccounts.filter(a => !a.groupId || !groups.find(g => String(g.id) === String(a.groupId)));

              const toggleGroup = (key) => {
                setExpandedGroups(prev => {
                  const n = new Set(prev);
                  n.has(key) ? n.delete(key) : n.add(key);
                  return n;
                });
              };
              const checkGroupBans = async (groupId, groupName) => {
                setGroupBanModal({ groupId, groupName, loading: true, data: null, error: null });
                try {
                  const resp = await api.post('accounts/check-bans', { groupId: groupId || undefined });
                  setGroupBanModal(prev => ({ ...prev, loading: false, data: resp.data }));
                  fetchAccounts(); // 刷新本地账号列表以同步刚保存的状态
                } catch (e) {
                  setGroupBanModal(prev => ({ ...prev, loading: false, error: e.response?.data?.error || e.message }));
                }
              };

              const handleTotpToggle = async (acc, e) => {

                e.stopPropagation();
                if (totpCodes.has(acc.id)) {
                  setTotpCodes(prev => { const n = new Map(prev); n.delete(acc.id); return n; });
                  return;
                }
                setTotpCodes(prev => new Map(prev).set(acc.id, { code: null, secondsRemaining: 30, loading: true }));
                fetchTotp(acc.id);
              };

              const handleCopyTotp = (code, e) => {
                e.stopPropagation();
                if (!code || code === '获取失败' || code === '无数据') return;
                const copySuccess = () => {
                  addNotification({
                    type: 'success',
                    title: '复制成功',
                    message: `验证码 ${code} 已复制到剪贴板`
                  });
                };

                navigator.clipboard.writeText(code).then(copySuccess).catch(() => {
                  // Fallback for older browsers or non-secure contexts
                  const el = document.createElement('textarea');
                  el.value = code;
                  document.body.appendChild(el);
                  el.select();
                  try {
                    document.execCommand('copy');
                    copySuccess();
                  } catch (err) {
                    console.error('Copy failed', err);
                  }
                  document.body.removeChild(el);
                });
              };

              const renderChip = (acc) => {
                const totp = totpCodes.get(acc.id);
                const grp = groups.find(g => String(g.id) === String(acc.groupId));

                const banMap = {
                  'normal': { text: '正常', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
                  'banned': { text: '异常', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
                  'suspicious': { text: '可疑', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' }
                };
                const banInfo = banMap[acc.banStatus] || null;

                return (
                  <div key={acc.id} className="c5-accard-wrap">
                    {editingTradeUrlId === acc.id ? (
                      <div className="c5-trade-url-edit-inline" onClick={e => e.stopPropagation()}>
                        <span className="c5-chip-name-label">{acc.name} — 交易链接:</span>
                        <input
                          className="c5-trade-url-input"
                          value={tradeUrlInput}
                          onChange={e => setTradeUrlInput(e.target.value)}
                          placeholder="https://steamcommunity.com/tradeoffer/new/..."
                          autoFocus
                        />
                        <button className="c5-confirm-btn" onClick={() => handleSaveTradeUrl(acc.id)}>保存</button>
                        <button className="c5-cancel-btn" onClick={() => setEditingTradeUrlId(null)}>✕</button>
                      </div>
                    ) : (
                      <div
                        className={`c5-accard ${selectedC5AccountId === acc.id ? 'active' : ''} ${acc.tradeUrl ? '' : 'no-trade'}`}
                        onClick={() => handleC5SelectAccount(acc.id)}
                      >
                        <div className="c5-accard-top">
                          <div className="c5-accard-avatar">{acc.name[0] ? acc.name[0].toUpperCase() : '?'}</div>
                          <div className="c5-accard-names">
                            <div className="c5-accard-name">{acc.name}</div>
                            {acc.personaName && <div className="c5-accard-persona">{acc.personaName}</div>}
                          </div>
                          {banInfo && (
                            <div style={{ marginLeft: 'auto', fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', color: banInfo.color, background: banInfo.bg, fontWeight: 700, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}>
                              {banInfo.text}
                            </div>
                          )}
                          {!acc.tradeUrl && <span className="c5-chip-warn" title="未设置交易链接" style={{ marginLeft: banInfo ? '5px' : 'auto' }}>⚠️</span>}
                        </div>

                        {totp ? (
                          <div className={`c5-accard-totp ${totp.isError ? 'error' : ''}`} onClick={e => handleTotpToggle(acc, e)}>
                            {totp.loading
                              ? <span className="c5-totp-loading">获取中...</span>
                              : (
                                <div className="c5-totp-content">
                                  <span className="c5-totp-code">{totp.code}</span>
                                  {totp.secondsRemaining > 0 && <span className="c5-totp-timer">{totp.secondsRemaining}s</span>}
                                  {!totp.isError && (
                                    <button
                                      className="c5-totp-copy-btn"
                                      onClick={e => handleCopyTotp(totp.code, e)}
                                      title="复制验证码"
                                    >
                                      复制
                                    </button>
                                  )}
                                </div>
                              )
                            }
                          </div>
                        ) : (
                          <div className="c5-accard-totp-hint" onClick={e => handleTotpToggle(acc, e)}>
                            🔐 点击获取令牌
                          </div>
                        )}

                        {acc.tradeUrlError && (
                          <div className="c5-accard-error-strip" title={acc.tradeUrlError}>
                            <span className="error-icon">⚠️</span>
                            <span className="error-text">{acc.tradeUrlError}</span>
                          </div>
                        )}

                        <div className="c5-accard-actions" onClick={e => e.stopPropagation()}>
                          {groups.length > 0 && (
                            <select
                              className="c5-chip-group-select"
                              value={acc.groupId || ''}
                              onChange={e => handleAssignGroup(acc.id, e.target.value ? Number(e.target.value) : null)}
                              style={grp ? { color: grp.color, borderColor: grp.color + '66', background: grp.color + '18' } : {}}
                              title="分配到分组"
                            >
                              <option value="">分组...</option>
                              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                          )}
                          <button
                            className="c5-chip-trade-url-btn"
                            title={acc.tradeUrl ? '复制交易链接' : '自动获取交易链接'}
                            onClick={() => handleCopyOrFetchTradeUrl(acc)}
                            disabled={fetchingTradeUrlId === acc.id}
                            style={{
                              opacity: fetchingTradeUrlId === acc.id ? 0.6 : 1,
                              background: acc.tradeUrl ? 'rgba(16,185,129,0.15)' : 'rgba(99,102,241,0.15)',
                              color: acc.tradeUrl ? '#10b981' : '#818cf8',
                              border: `1px solid ${acc.tradeUrl ? '#10b98133' : '#818cf833'}`,
                              borderRadius: '6px',
                              padding: '3px 7px',
                              cursor: fetchingTradeUrlId === acc.id ? 'wait' : 'pointer',
                              fontSize: '0.75rem',
                              whiteSpace: 'nowrap',
                              transition: 'all 0.2s'
                            }}
                          >
                            {fetchingTradeUrlId === acc.id ? '获取中...' : (acc.tradeUrl ? '🔗 复制链接' : '🔗 获取链接')}
                          </button>
                          <button
                            className="c5-chip-edit-btn"
                            title="手动设置交易链接"
                            onClick={() => { setEditingTradeUrlId(acc.id); setTradeUrlInput(acc.tradeUrl || ''); }}
                          >✏️</button>
                          <button
                            title={acc.accountPassword ? '用已保存密码重新登录 Steam（刷新 RefreshToken）' : '输入密码重新登录 Steam（刷新 RefreshToken）'}
                            onClick={e => { e.stopPropagation(); setReloginDialog({ acc, password: acc.accountPassword || '', loading: false, error: null }); }}
                            disabled={reloginIds.has(acc.id)}
                            style={{
                              background: 'rgba(99,102,241,0.12)',
                              color: '#818cf8',
                              border: '1px solid rgba(99,102,241,0.3)',
                              borderRadius: '6px',
                              padding: '3px 7px',
                              cursor: reloginIds.has(acc.id) ? 'wait' : 'pointer',
                              fontSize: '0.8rem',
                              lineHeight: 1,
                              transition: 'all 0.2s',
                              opacity: reloginIds.has(acc.id) ? 0.5 : 1
                            }}
                          >{reloginIds.has(acc.id) ? '登录中...' : '🔑'}</button>
                          <button
                            title="删除该账号"
                            onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
                            style={{
                              background: 'rgba(239,68,68,0.12)',
                              color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.3)',
                              borderRadius: '6px',
                              padding: '3px 7px',
                              cursor: 'pointer',
                              fontSize: '0.8rem',
                              lineHeight: 1,
                              transition: 'all 0.2s'
                            }}
                          >🗑️</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div className="c5-group-accordion">
                  {/* 全部 */}
                  <div className="c5-group-section">
                    <div
                      className={`c5-group-section-header ${!selectedGroupId && c5InventoryViewMode === 'all' ? 'active' : ''}`}
                      onClick={() => { setC5InventoryViewMode('all'); setSelectedGroupId(null); setSelectedC5AccountId(null); fetchGroupInventory(null, false); }}
                      style={{ '--gc': '#667eea' }}
                    >
                      <span className="c5-gsec-dot" style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)' }} />
                      <span className="c5-gsec-name">全部</span>
                      <span className="c5-gsec-count">{steamAccounts.length} 个账号</span>
                      <span
                        className={`c5-gsec-arrow ${expandedGroups.has('__all__') ? 'expanded' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleGroup('__all__'); }}
                        title={expandedGroups.has('__all__') ? "隐藏账号列表" : "显示账号列表"}
                      >
                        {expandedGroups.has('__all__') ? '▾ 账号' : '▸ 账号'}
                      </span>
                      <button
                        className="group-ban-check-btn"
                        onClick={(e) => { e.stopPropagation(); checkGroupBans(null, '全部'); }}
                        title="检测全部账号封禁状态"
                      >🛡️ 检测</button>
                    </div>
                    {expandedGroups.has('__all__') && (
                      <div className="c5-group-section-chips">{steamAccounts.map(renderChip)}</div>
                    )}
                  </div>

                  {/* 各分组 */}
                  {grouped.map(g => (
                    <div key={g.id} className="c5-group-section">
                      <div
                        className={`c5-group-section-header ${String(selectedGroupId) === String(g.id) && c5InventoryViewMode === 'all' ? 'active' : ''}`}
                        onClick={() => { setC5InventoryViewMode('all'); setSelectedGroupId(g.id); setSelectedC5AccountId(null); fetchGroupInventory(g.id, false); }}
                        style={{ '--gc': g.color }}
                      >
                        <span className="c5-gsec-dot" style={{ background: g.color }} />
                        <span className="c5-gsec-name">{g.name}</span>
                        <span className="c5-gsec-count">{g.accounts.length} 个账号</span>
                        <span
                          className={`c5-gsec-arrow ${expandedGroups.has(String(g.id)) ? 'expanded' : ''}`}
                          onClick={(e) => { e.stopPropagation(); toggleGroup(String(g.id)); }}
                          title={expandedGroups.has(String(g.id)) ? "隐藏账号列表" : "显示账号列表"}
                        >
                          {expandedGroups.has(String(g.id)) ? '▾ 账号' : '▸ 账号'}
                        </span>
                        <button
                          className="group-ban-check-btn"
                          onClick={(e) => { e.stopPropagation(); checkGroupBans(g.id, g.name); }}
                          title={`检测 ${g.name} 封禁状态`}
                        >🛡️ 检测</button>
                      </div>
                      {expandedGroups.has(String(g.id)) && (
                        <div className="c5-group-section-chips">
                          {g.accounts.length === 0
                            ? <div className="c5-gsec-empty">暂无账号，请通过分组选择器将账号分配到该组</div>
                            : g.accounts.map(renderChip)
                          }
                        </div>
                      )}
                    </div>
                  ))}

                  {/* 未分组 */}
                  {ungrouped.length > 0 && (
                    <div className="c5-group-section">
                      <div
                        className={`c5-group-section-header ${selectedGroupId === '__ungrouped__' && c5InventoryViewMode === 'all' ? 'active' : ''}`}
                        onClick={() => { setC5InventoryViewMode('all'); setSelectedGroupId('__ungrouped__'); setSelectedC5AccountId(null); fetchGroupInventory('__ungrouped__', false); }}
                        style={{ '--gc': '#64748b' }}
                      >
                        <span className="c5-gsec-dot" style={{ background: '#64748b' }} />
                        <span className="c5-gsec-name">未分组</span>
                        <span className="c5-gsec-count">{ungrouped.length} 个账号</span>
                        <span
                          className={`c5-gsec-arrow ${expandedGroups.has('__ungrouped__') ? 'expanded' : ''}`}
                          onClick={(e) => { e.stopPropagation(); toggleGroup('__ungrouped__'); }}
                        >
                          {expandedGroups.has('__ungrouped__') ? '▾ 账号' : '▸ 账号'}
                        </span>
                        <button
                          className="group-ban-check-btn"
                          onClick={(e) => { e.stopPropagation(); checkGroupBans('__ungrouped__', '未分组'); }}
                          title="检测未分组账号封禁状态"
                        >🛡️ 检测</button>
                      </div>
                      {expandedGroups.has('__ungrouped__') && (
                        <div className="c5-group-section-chips">{ungrouped.map(renderChip)}</div>
                      )}
                    </div>
                  )}

                  {steamAccounts.length === 0 && (
                    <div className="c5-accounts-empty">暂无账号，请点击"批量导入"添加 Steam 账号</div>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="c5-inv-section">
            {/* 控制栏 */}
            <div className="c5-inv-header">
              <div className="c5-inv-header-left">
                <div className="c5-section-title" style={{ marginBottom: 0 }}>📦 库存视图</div>
                {(c5TotalValue > 0 || isFetchingC5Prices) && (
                  <div className="c5-inv-value-badge">
                    <span className="label">共 {c5TotalCount} 件</span>
                    <span className="value">
                      {isFetchingC5Prices ? '正在计算...' : `¥ ${c5TotalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </span>
                  </div>
                )}
              </div>

              <div className="c5-inv-controls">
                <div className="c5-view-mode-toggle">
                  <button
                    className={`c5-vm-btn ${c5InventoryViewMode === 'single' ? 'active' : ''}`}
                    onClick={() => setC5InventoryViewMode('single')}
                  >单账户</button>
                  <button
                    className={`c5-vm-btn ${c5InventoryViewMode === 'all' ? 'active' : ''}`}
                    onClick={() => { setC5InventoryViewMode('all'); fetchGroupInventory(selectedGroupId, false); }}
                  >{selectedGroupId ? `分组: ${groups.find(g => g.id === selectedGroupId)?.name || ''}` : '所有账户'}</button>
                </div>
                <button
                  className={`c5-stack-btn ${c5StackMode ? 'active' : ''}`}
                  onClick={() => setC5StackMode(v => !v)}
                  title={c5StackMode ? '点击取消堆叠' : '点击启用堆叠'}
                >⊞ 堆叠</button>
                <input
                  className="c5-inv-search"
                  placeholder="搜索饰品名称…"
                  value={c5InventorySearch}
                  onChange={e => setC5InventorySearch(e.target.value)}
                />
                {/* Bulk sync button */}
                <div className="c5-sync-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '5px' }}>
                  {inventoryCache[selectedGroupId || 'all']?.timestamp && (
                    <div className="last-sync-time" style={{ fontSize: '0.75rem', opacity: 0.6, color: 'var(--text-color)' }}>
                      🕒 上次同步: {new Date(inventoryCache[selectedGroupId || 'all'].timestamp).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                  )}
                  <button
                    className="c5-sync-all-btn"
                    disabled={!!groupSyncProgress}
                    onClick={() => fetchGroupInventory(selectedGroupId, true)}
                    title="强制全量同步库存（绕过缓存）"
                  >
                    {groupSyncProgress
                      ? `${groupSyncProgress.current}/${groupSyncProgress.total}…`
                      : '⚡ 同步全部'}
                  </button>
                </div>
                <button className="c5-inv-refresh-btn" onClick={() => {
                  if (c5InventoryViewMode === 'all') {
                    fetchGroupInventory(selectedGroupId);
                  } else {
                    const acc = steamAccounts.find(a => a.id === selectedC5AccountId);
                    if (acc && acc.steamId64) {
                      fetchC5Inventory(acc.steamId64);
                      fetchC5Listings(acc.steamId64);
                    }
                  }
                }}>🔄 刷新</button>
                <button
                  className="c5-inv-refresh-btn"
                  style={{ background: 'var(--accent-color)', color: '#000', fontWeight: 'bold' }}
                  onClick={() => fetchBatchC5Prices(c5InventoryViewMode === 'all' ? c5AllInventory : c5Inventory)}
                  disabled={isFetchingC5Prices}
                >
                  {isFetchingC5Prices ? '正在查价...' : '💰 获取 C5 价格'}
                </button>
              </div>
            </div>
            {/* Sync progress bar */}
            {groupSyncProgress && (
              <div className="c5-sync-progress">
                <div
                  className="c5-sync-progress-bar"
                  style={{ width: `${(groupSyncProgress.current / groupSyncProgress.total) * 100}%` }}
                />
                <span className="c5-sync-progress-label">同步中... {groupSyncProgress.current}/{groupSyncProgress.total} 账号</span>
              </div>
            )}

            {/* 批量上架工具栏 */}
            {c5SelectedTokens.size > 0 && (
              <div className="c5-batch-toolbar">
                <span className="c5-batch-count">已选 <b>{c5SelectedTokens.size}</b> 件</span>
                {c5StatusView === 'listed' ? (
                  <>
                    <input
                      className="c5-batch-price-input"
                      type="number"
                      step="0.01"
                      placeholder="统一改价 (¥)"
                      value={c5BatchModifyPriceInput}
                      onChange={e => setC5BatchModifyPriceInput(e.target.value)}
                    />
                    <button
                      className="c5-batch-submit-btn c5-batch-modify-btn"
                      onClick={handleC5BatchModifyPrice}
                      disabled={c5BatchModifyLoading || c5BatchLoading}
                    >
                      {c5BatchModifyLoading ? '处理中…' : '✏️ 批量改价'}
                    </button>
                    <button
                      className="c5-batch-delist-btn"
                      onClick={handleC5BatchDelist}
                      disabled={c5BatchLoading || c5BatchModifyLoading}
                    >
                      {c5BatchLoading ? '处理中…' : '🗑️ 批量下架'}
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="c5-batch-price-input"
                      type="number"
                      step="0.01"
                      placeholder="统一上架价 (¥)"
                      value={c5BatchListPrice}
                      onChange={e => setC5BatchListPrice(e.target.value)}
                    />
                    <button className="c5-batch-submit-btn" onClick={handleC5BatchList} disabled={c5BatchLoading}>
                      {c5BatchLoading ? '处理中…' : '🚀 批量上架'}
                    </button>
                  </>
                )}
                <button className="c5-batch-cancel-btn" onClick={() => setC5SelectedTokens(new Set())}>✕ 清空</button>
              </div>
            )}

            {/* 筛选栏 */}
            <div className="c5-filter-bar">
              <div className="c5-filter-group">
                <span className="c5-filter-label">排序</span>
                <div className="c5-sort-btns">
                  <button className={`c5-sort-btn ${c5SortOrder === 'asc' ? 'active' : ''}`} onClick={() => setC5SortOrder(c5SortOrder === 'asc' ? 'none' : 'asc')}>价格 ↑</button>
                  <button className={`c5-sort-btn ${c5SortOrder === 'desc' ? 'active' : ''}`} onClick={() => setC5SortOrder(c5SortOrder === 'desc' ? 'none' : 'desc')}>价格 ↓</button>
                </div>
              </div>
              <div className="c5-filter-group">
                <span className="c5-filter-label">价格区间</span>
                <input className="c5-filter-price" type="number" step="0.01" placeholder="最低" value={c5PriceMin} onChange={e => setC5PriceMin(e.target.value)} />
                <span className="c5-filter-sep">—</span>
                <input className="c5-filter-price" type="number" step="0.01" placeholder="最高" value={c5PriceMax} onChange={e => setC5PriceMax(e.target.value)} />
              </div>
              <div className="c5-filter-group">
                <label className="c5-filter-check">
                  <input type="checkbox" checked={c5HideGraffiti} onChange={e => setC5HideGraffiti(e.target.checked)} />
                  隐藏涂鸦
                </label>
                <label className="c5-filter-check">
                  <input type="checkbox" checked={c5HideNonTradable} onChange={e => setC5HideNonTradable(e.target.checked)} />
                  隐藏不可交易
                </label>
              </div>
              <div className="c5-filter-group">
                <span className="c5-filter-label">快速视图</span>
                <div className="c5-sort-btns">
                  <button className={`c5-sort-btn ${c5StatusView === 'all' ? 'active' : ''}`} onClick={() => setC5StatusView('all')}>全部</button>
                  <button className={`c5-sort-btn ${c5StatusView === 'sellable' ? 'active' : ''}`} onClick={() => setC5StatusView('sellable')}>可出售</button>
                  <button className={`c5-sort-btn ${c5StatusView === 'listed' ? 'active' : ''}`} onClick={() => setC5StatusView('listed')}>在售中</button>
                  <button className={`c5-sort-btn ${c5StatusView === 'locked' ? 'active' : ''}`} style={c5StatusView === 'locked' ? { background: 'rgba(251,191,36,0.2)', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.5)' } : {}} onClick={() => setC5StatusView('locked')}>🔒 冷却中</button>
                </div>
              </div>
            </div>

            {/* 库存卡片网格 */}
            {(() => {
              const isAll = c5InventoryViewMode === 'all';
              const loading = isAll ? c5AllInventoryLoading : c5InventoryLoading;
              const hasData = (isAll ? c5AllInventory : c5Inventory).length > 0;
              const rawItems = isAll ? c5AllInventory : c5Inventory;

              if (loading && !hasData) return <div className="c5-loading-msg">🔄 正在加载库存…</div>;
              if (!isAll && !selectedC5AccountId) return <div className="c5-empty-msg">← 请先在上方点击选择一个 Steam 账号</div>;

              const priceMin = c5PriceMin !== '' ? parseFloat(c5PriceMin) : null;
              const priceMax = c5PriceMax !== '' ? parseFloat(c5PriceMax) : null;

              let filtered = rawItems.filter(item => {
                // 快速视图模式（互斥）
                if (c5StatusView === 'sellable' && item.status !== 0) return false;
                if (c5StatusView === 'listed' && item.status !== 1) return false;
                if (c5StatusView === 'locked' && !item.locked) return false;
                // 关键词搜索
                if (c5InventorySearch && !(item.name || item.marketHashName || '').toLowerCase().includes(c5InventorySearch.toLowerCase())) return false;
                // 隐藏不可交易（状态 2 和 3）
                if (c5HideNonTradable && (item.status === 2 || item.status === 3)) return false;
                // 隐藏涂鸦
                if (c5HideGraffiti) {
                  const t = item.itemInfo && item.itemInfo.type;
                  const n = (item.name || '') + (item.marketHashName || '');
                  if (t === 'CSGO_Type_Spray' || n.includes('Graffiti') || n.includes('涂鸦')) return false;
                }
                // 价格区间
                const price = parseFloat(item.price);
                if (priceMin != null && price < priceMin) return false;
                if (priceMax != null && price > priceMax) return false;
                return true;
              });

              let displayItems;
              if (c5StackMode) {
                const groups = {};
                filtered.forEach(item => {
                  const priceStr = parseFloat(item.price || 0).toFixed(2);
                  const key = `${item.marketHashName || item.name || item.token}_${priceStr}`;
                  if (!groups[key]) groups[key] = [];
                  groups[key].push(item);
                });
                displayItems = Object.values(groups).map(g => ({
                  ...g[0],
                  _count: g.length,
                  _allTokens: g.map(i => i.token),
                  _accounts: [...new Set(g.map(i => i._accountName).filter(Boolean))],
                }));
              } else {
                displayItems = filtered.map(item => ({
                  ...item, _count: 1,
                  _allTokens: [item.token],
                  _accounts: item._accountName ? [item._accountName] : [],
                }));
              }

              // 价格排序
              if (c5SortOrder === 'asc') {
                displayItems.sort((a, b) => parseFloat(a.price || 0) - parseFloat(b.price || 0));
              } else if (c5SortOrder === 'desc') {
                displayItems.sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0));
              }

              if (displayItems.length === 0) return <div className="c5-empty-msg">📭 暂无符合条件的库存</div>;

              // Calculate total inventory value and count
              let totalValue = 0;
              let totalCount = 0;
              displayItems.forEach(item => {
                const c5P = c5MarketPrices[item.marketHashName || item.name];
                // Handle both raw numbers and objects with sellPrice
                const price = (c5P != null)
                  ? (typeof c5P === 'object' ? (c5P.sellPrice || 0) : c5P)
                  : (item.price || 0);
                const count = (item._count || 1);
                totalValue += parseFloat(price) * count;
                totalCount += count;
              });

              if (Math.abs(totalValue - c5TotalValue) > 0.001 || totalCount !== c5TotalCount) {
                // Use setTimeout to avoid "cannot update while rendering" error
                setTimeout(() => {
                  setC5TotalValue(totalValue);
                  setC5TotalCount(totalCount);
                }, 0);
              }

              return (
                <div className="c5-inv-grid">
                  {displayItems.map((item, idx) => {
                    const statusInfo = C5_STATUS_LABELS[item.status] != null
                      ? C5_STATUS_LABELS[item.status]
                      : { label: '未知', color: '#94a3b8' };
                    const allSel = item._allTokens.every(t => c5SelectedTokens.has(t));
                    const partSel = !allSel && item._allTokens.some(t => c5SelectedTokens.has(t));
                    const isListingThis = c5ListingToken && item._allTokens.includes(c5ListingToken);
                    const rawWear = parseFloat(item.assetInfo ? item.assetInfo.wear : -1);
                    const wearVal = (!isNaN(rawWear) && rawWear >= 0) ? rawWear.toFixed(4) : null;

                    const extName = item.itemInfo?.exteriorName || null;
                    const rarityColor = item.itemInfo?.rarityColor || 'rgba(255,255,255,0.05)';

                    return (
                      <div
                        key={idx}
                        className={'c5-inv-card' + (allSel ? ' selected' : '') + (partSel ? ' part-selected' : '')}
                        onClick={() => toggleC5Token(item._allTokens)}
                      >
                        <div
                          className="c5-inv-card-img"
                          style={{ borderBottom: `4px solid ${rarityColor}` }}
                        >
                          <div className="c5-inv-status-badge" style={{ background: statusInfo.color }}>
                            {statusInfo.label}
                          </div>
                          {item._count > 1 && <div className="c5-inv-count-badge">x{item._count}</div>}
                          <input
                            type="checkbox"
                            className="c5-inv-card-checkbox"
                            checked={allSel}
                            onChange={() => toggleC5Token(item._allTokens)}
                            onClick={e => e.stopPropagation()}
                          />
                          {item.imageUrl
                            ? <img src={item.imageUrl} alt={item.marketHashName} />
                            : <div className="c5-inv-card-no-img">?</div>
                          }
                          {wearVal && <div className="c5-inv-wear-float">{wearVal}</div>}
                        </div>
                        <div className="c5-inv-card-body">
                          <div className="c5-inv-card-name" title={item.name || item.marketHashName}>
                            {item.name || item.marketHashName}
                          </div>
                          {extName && (
                            <div className="c5-inv-card-wear">
                              ({extName})
                            </div>
                          )}
                          {item.locked && (
                            <div style={{ fontSize: '0.68rem', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '4px', padding: '2px 5px', marginTop: '3px', lineHeight: 1.3 }}>
                              🔒 冷却中{item.tradeHoldExpiry ? `：${item.tradeHoldExpiry}` : ''}
                            </div>
                          )}
                          {(item.price != null || c5MarketPrices[item.marketHashName || item.name] != null) && (
                            <div className="c5-inv-card-price">
                              {(() => {
                                const p = c5MarketPrices[item.marketHashName || item.name];
                                const c5PriceVal = (p != null) ? (typeof p === 'object' ? (p.sellPrice || 0) : p) : 0;
                                const currentPrice = item.price || 0;

                                // Primary price to show
                                const displayPrice = c5PriceVal > 0 ? c5PriceVal : currentPrice;

                                return (
                                  <>
                                    ¥ {parseFloat(displayPrice).toFixed(2)}
                                    {/* 
                                        Only show "Market Price" tag if:
                                        1. The item is actively listed (status 1), OR
                                        2. C5 price is different from the cached item price (and both exist)
                                    */}
                                    {((item.status === 1 && c5PriceVal > 0) || (c5PriceVal > 0 && currentPrice > 0 && Math.abs(c5PriceVal - currentPrice) > 0.01)) && (
                                      <span style={{ fontSize: '11px', color: '#ff9800', marginLeft: '6px' }} title="C5 市场最新底价">
                                        市: ¥ {parseFloat(c5PriceVal).toFixed(2)}
                                      </span>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                          {!c5StackMode && item._accounts && item._accounts.length > 0 && (
                            <div className="c5-inv-card-accounts">
                              {item._accounts.map((n, i) => <span key={i} className="c5-inv-acct-tag">{n}</span>)}
                            </div>
                          )}
                          {item.status === 0 ? (
                            isListingThis ? (
                              <div className="c5-inv-list-inline" onClick={e => e.stopPropagation()}>
                                <div className="c5-inv-list-row">
                                  <input
                                    className="c5-price-input"
                                    type="number" step="0.01"
                                    placeholder={item.price ? parseFloat(item.price).toFixed(2) : '价格'}
                                    value={c5ListPriceInput}
                                    onChange={e => setC5ListPriceInput(e.target.value)}
                                    autoFocus
                                  />
                                  {item._count > 1 && (
                                    <input
                                      className="c5-qty-input"
                                      type="number"
                                      min="1"
                                      max={item._count}
                                      value={c5ListQuantity}
                                      onChange={e => setC5ListQuantity(Math.min(Math.max(1, parseInt(e.target.value) || 1), item._count))}
                                      title={`上架数量（最多 ${item._count}）`}
                                    />
                                  )}
                                </div>
                                <div className="c5-inv-list-row">
                                  <button className="c5-confirm-btn" style={{ flex: 1 }} onClick={handleC5ListItem}>
                                    确认{item._count > 1 ? ` (${Math.min(c5ListQuantity, item._count)})` : ''}
                                  </button>
                                  <button className="c5-cancel-btn" onClick={() => { setC5ListingToken(null); setC5ListPriceInput(''); setC5ListQuantity(1); }}>取消</button>
                                </div>
                              </div>
                            ) : (
                              <button
                                className="c5-inv-list-btn"
                                onClick={e => {
                                  e.stopPropagation();
                                  setC5ListingToken(item._allTokens[0]);
                                  setC5ListingItemObj(item);
                                  setC5ListPriceInput(item.price ? parseFloat(item.price).toFixed(2) : '');
                                  setC5ListQuantity(1);
                                }}
                              >
                                {item._count > 1 ? `上架 (1/${item._count})` : '上架'}
                              </button>
                            )
                          ) : item.status === 1 ? (() => {
                            const listMatch = c5Listings.find(l => l.token === item._allTokens[0] || (l.assetInfo && l.assetInfo.token === item._allTokens[0]));
                            const _saleId = item.productId || item.saleId || listMatch?.id || item.id;
                            const _isModifying = c5ModifyDialog && c5ModifyDialog.saleId === _saleId;

                            return _isModifying ? (
                              <div className="c5-inv-list-inline" onClick={e => e.stopPropagation()}>
                                <div className="c5-inv-list-row">
                                  <input
                                    className="c5-price-input"
                                    type="number" step="0.01"
                                    placeholder="新价格"
                                    value={c5ModifyPriceInput}
                                    onChange={e => setC5ModifyPriceInput(e.target.value)}
                                    autoFocus
                                  />
                                  {item._count > 1 && (
                                    <input
                                      className="c5-qty-input"
                                      type="number"
                                      min="1"
                                      max={item._count}
                                      value={c5ModifyQuantity}
                                      onChange={e => setC5ModifyQuantity(Math.min(Math.max(1, parseInt(e.target.value) || 1), item._count))}
                                      title={`改价数量（最多 ${item._count}）`}
                                    />
                                  )}
                                </div>
                                <div className="c5-inv-list-row">
                                  <button className="c5-confirm-btn" style={{ flex: 1 }} onClick={handleC5ModifyPrice}>
                                    确认{item._count > 1 ? ` (${Math.min(c5ModifyQuantity, item._count)})` : ''}
                                  </button>
                                  <button className="c5-cancel-btn" onClick={() => { setC5ModifyDialog(null); setC5ModifyQuantity(1); }}>取消</button>
                                </div>
                              </div>
                            ) : (
                              <div className="c5-inv-listed-actions" onClick={e => e.stopPropagation()}>
                                <button
                                  className="c5-modify-btn"
                                  onClick={() => {
                                    setC5ModifyDialog({ saleId: _saleId, currentPrice: item.price, item });
                                    setC5ModifyPriceInput(parseFloat(item.price || 0).toFixed(2));
                                    setC5ModifyQuantity(1);
                                  }}
                                >✏️ 改价</button>
                                <button
                                  className="c5-delist-btn"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (_saleId === undefined || _saleId === null) {
                                      console.warn('[C5下架] 找不到挂单ID, item:', item);
                                      return addNotification({
                                        title: 'C5 挂单ID未同步',
                                        message: '刚上架的物品需要等几秒才能同步，请点击刷新按钮后再试',
                                        type: 'warning'
                                      });
                                    }
                                    handleC5Delist(_saleId);
                                  }}
                                >🗑️ 下架</button>
                              </div>
                            );
                          })() : (
                            <div className="c5-inv-no-list-tip">
                              {statusInfo.label}，不可上架
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {/* ─── C5 挂单区域 ─── */}
          {selectedC5AccountId && (
            <div className="c5-data-section">
              <div className="c5-sub-tabs">
                <div style={{ padding: '0.85rem 1.25rem', color: '#38bdf8', fontWeight: 700, fontSize: '0.9rem' }}>
                  🏷️ C5 挂单 — {steamAccounts.find(a => a.id === selectedC5AccountId) ? steamAccounts.find(a => a.id === selectedC5AccountId).name : ''}
                </div>
                <button
                  className="c5-inv-refresh-btn"
                  style={{ margin: '0.5rem 1rem 0.5rem auto' }}
                  onClick={() => {
                    const acc = steamAccounts.find(a => a.id === selectedC5AccountId);
                    if (acc && acc.steamId64) fetchC5Listings(acc.steamId64);
                  }}
                >🔄 刷新挂单</button>
              </div>
              <div className="c5-listings-panel">
                {c5ListingsLoading ? (
                  <div className="c5-loading-msg">🔄 正在加载 C5 挂单...</div>
                ) : c5Listings.length === 0 ? (
                  <div className="c5-empty-msg">📭 该账号暂无 C5 在售挂单</div>
                ) : (
                  <div className="c5-item-list">
                    {c5Listings.map((listing, idx) => (
                      <div key={idx} className="c5-item-row">
                        {listing.imageUrl && <img src={listing.imageUrl} alt={listing.marketHashName} className="c5-item-img" />}
                        <div className="c5-item-info">
                          <div className="c5-item-name">{listing.marketHashName || listing.name}</div>
                          {listing.itemInfo && listing.itemInfo.exteriorName && (
                            <div className="c5-item-wear" style={{ color: listing.itemInfo.exteriorColor }}>
                              {listing.itemInfo.exteriorName}
                            </div>
                          )}
                          <div className="c5-listing-price">上架价: ¥ {parseFloat(listing.price || 0).toFixed(2)}</div>
                          {listing.status != null && (
                            <div className="c5-listing-status" style={{ color: C5_STATUS_LABELS[listing.status] ? C5_STATUS_LABELS[listing.status].color : '#94a3b8' }}>
                              {C5_STATUS_LABELS[listing.status] ? C5_STATUS_LABELS[listing.status].label : '状态' + listing.status}
                            </div>
                          )}
                        </div>
                        <div className="c5-listing-actions">
                          {c5ModifyDialog && c5ModifyDialog.saleId === listing.id ? (
                            <div className="c5-list-inline">
                              <input className="c5-price-input" type="number" step="0.01" placeholder="新价格"
                                value={c5ModifyPriceInput} onChange={e => setC5ModifyPriceInput(e.target.value)} />
                              <button className="c5-confirm-btn" onClick={handleC5ModifyPrice}>确认</button>
                              <button className="c5-cancel-btn" onClick={() => setC5ModifyDialog(null)}>取消</button>
                            </div>
                          ) : (
                            <>
                              <button className="c5-modify-btn" onClick={() => { setC5ModifyDialog({ saleId: listing.id, currentPrice: listing.price }); setC5ModifyPriceInput(parseFloat(listing.price || 0).toFixed(2)); }}>改价</button>
                              <button className="c5-delist-btn" onClick={() => handleC5Delist(listing.id)}>下架</button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── C5 购买面板 ─── */}
          <div className="c5-buy-panel">
            <div className="c5-section-title">🛒 C5 购买</div>

            {/* 搜索区 */}
            <div className="c5-buy-search-row">
              <input
                className="c5-buy-input"
                placeholder="输入饰品中文名称搜索 (如: MAC-10)"
                value={c5BuyHashName}
                onChange={e => setC5BuyHashName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleC5BuySearch()}
              />
              <button className="c5-search-btn" onClick={handleC5BuySearch} disabled={c5BuyLoading} style={{ marginLeft: '10px' }}>
                {c5BuyLoading ? '搜索中…' : '🔍 搜索'}
              </button>
            </div>

            {/* 收货账号选择 */}
            <div className="c5-buy-acct-row">
              <label className="c5-buy-acct-label">收货账号 (需配置交易链接):</label>
              <select className="c5-buy-acct-select" value={c5BuyAccountId} onChange={e => setC5BuyAccountId(e.target.value)}>
                <option value="">── 选择收货账号 ──</option>
                {steamAccounts.filter(a => a.tradeUrl).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {/* 搜索结果 */}
            {c5BuyResults && c5BuyResults.length > 0 && (
              <div className="c5-buy-results">
                <div className="c5-buy-results-header">
                  找到 {c5BuyResults.length} 个磨损档位，点击立刻以C5底价购买:
                </div>
                <div className="c5-buy-result-list">
                  {c5BuyResults.map((r, idx) => (
                    <div
                      key={idx}
                      className="c5-buy-result-row"
                    >
                      {r.image && <img src={r.image} className="c5-buy-result-img" alt={r.hash_name} />}
                      <div className="c5-buy-result-info">
                        <div className="c5-buy-result-name" style={{ fontWeight: 'bold' }}>{r.name || r.hash_name}</div>
                        <div className="c5-buy-result-wear" style={{ opacity: 0.8, fontSize: '0.85em', marginTop: '2px' }}>
                          磨损分类: {r.wear}
                        </div>
                        <div className="c5-buy-result-price" style={{ color: '#2ecc71', fontWeight: 'bold', marginTop: '4px' }}>
                          {r.c5Price !== 'N/A' ? `C5底价: ¥ ${r.c5Price}` : '暂无底价'}
                        </div>
                      </div>
                      <button
                        className="c5-buy-single-btn"
                        style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #00C6FF, #0072FF)', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                        disabled={!c5BuyAccountId || c5BuyLoading || r.c5Price === 'N/A'}
                        onClick={e => { e.stopPropagation(); handleC5BuySingle(r); }}
                      >
                        立即购买
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {c5BuyResults && c5BuyResults.length === 0 && (
              <div className="c5-empty-msg">📭 未找到符合条件的商品</div>
            )}
          </div>

        </div>
      )}

      {/* ── Modals (shared) ── */}
      {isScannerModalOpen && (
        <div className="modal-overlay" style={{ zIndex: 99999 }} onClick={() => setIsScannerModalOpen(false)}>
          <div className="modal-content glass-effect scanner-modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '850px' }}>
            <RedLetterScanner onClose={() => setIsScannerModalOpen(false)} />
          </div>
        </div>
      )}

      {/* ── 库存批量转移弹窗 ── */}
      {isTransferModalOpen && (
        <InventoryTransferModal
          onClose={() => setIsTransferModalOpen(false)}
          accounts={steamAccounts}
          groups={groups}
        />
      )}

      {/* ── 令牌确认弹窗 ── */}
      {isConfirmModalOpen && (
        <TradeConfirmModal
          onClose={() => setIsConfirmModalOpen(false)}
          accounts={steamAccounts}
          groups={groups}
        />
      )}

      {/* ── 批量密码导入弹窗 ── */}
      {isBatchPasswordModalOpen && (() => {
        // 解析函数：支持 ----, ---, --, :, |, TAB 等分隔符
        const parsePwdLine = (line) => {
          const cleaned = line.trim();
          if (!cleaned) return null;
          // 优先匹配最长的分隔符
          const separators = ['----', '---', '--', '\t', ' | ', '|', ':'];
          for (const sep of separators) {
            const idx = cleaned.indexOf(sep);
            if (idx > 0) {
              const name = cleaned.slice(0, idx).trim();
              const pass = cleaned.slice(idx + sep.length).trim();
              if (name && pass) return { name, password: pass };
            }
          }
          return null;
        };

        const BatchPasswordModal = () => {
          const [rawText, setRawText] = useState('');
          const [syncResult, setSyncResult] = useState(null);
          const [syncing, setSyncing] = useState(false);
          const nameSet = new Set(steamAccounts.map(a => (a.name || '').toLowerCase()));

          const parsed = useMemo(() =>
            rawText.split('\n').map(parsePwdLine).filter(Boolean)
            , [rawText]);

          const matched = parsed.filter(e => nameSet.has(e.name.toLowerCase()));
          const unmatched = parsed.filter(e => !nameSet.has(e.name.toLowerCase()));

          const handleFile = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => setRawText(ev.target.result);
            reader.readAsText(file, 'utf-8');
            e.target.value = '';
          };

          const handleSync = async () => {
            if (matched.length === 0) return;
            setSyncing(true);
            try {
              const resp = await api.post('accounts/batch-update-passwords', { entries: matched });
              setSyncResult(resp.data);
            } catch (e) {
              setSyncResult({ error: e.response?.data?.error || e.message });
            } finally {
              setSyncing(false);
            }
          };

          return (
            <div className="modal-overlay" style={{ zIndex: 99999 }} onClick={() => setIsBatchPasswordModalOpen(false)}>
              <div
                style={{
                  background: '#1a1d2e', border: '1px solid rgba(124,58,237,0.4)',
                  borderRadius: '14px', padding: '1.5rem', width: '520px', maxWidth: '95vw',
                  maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.6)'
                }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1.05rem' }}>🔑 批量导入账号密码</h3>
                  <button onClick={() => setIsBatchPasswordModalOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.3rem' }}>×</button>
                </div>

                <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: '0 0 1rem', lineHeight: 1.6 }}>
                  每行一条，支持格式：<code style={{ color: '#a78bfa' }}>账号----密码</code>（也支持 <code style={{ color: '#a78bfa' }}>--</code>、<code style={{ color: '#a78bfa' }}>:</code>、<code style={{ color: '#a78bfa' }}>|</code> 等分隔符）。
                  系统会根据账号名自动匹配数据库记录并填入密码。
                </p>

                <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <label htmlFor="pwd-file-input" style={{
                    padding: '0.4rem 0.9rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem',
                    background: 'rgba(124,58,237,0.2)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.4)'
                  }}>
                    📂 导入 .txt 文件
                  </label>
                  <input id="pwd-file-input" type="file" accept=".txt" style={{ display: 'none' }} onChange={handleFile} />
                  {rawText && <button onClick={() => { setRawText(''); setSyncResult(null); }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '0.8rem' }}>清空</button>}
                </div>

                <textarea
                  value={rawText}
                  onChange={e => { setRawText(e.target.value); setSyncResult(null); }}
                  placeholder={"直接粘贴账号密码列表：\ntiqhogpq251----7PGOfBacikep\ncnln39595----QtzQxIjP6zWb\n..."}
                  style={{
                    width: '100%', height: '200px', background: '#0f1117', color: '#e2e8f0',
                    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '0.75rem',
                    fontSize: '0.8rem', resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box'
                  }}
                />

                {parsed.length > 0 && !syncResult && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', fontSize: '0.82rem' }}>
                    <div style={{ marginBottom: '0.4rem', color: '#f1f5f9' }}>📊 解析预览（共 {parsed.length} 条）</div>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                      <span style={{ color: '#22c55e' }}>✅ 可匹配 {matched.length} 个</span>
                      {unmatched.length > 0 && <span style={{ color: '#f59e0b' }}>⚠️ 未找到 {unmatched.length} 个</span>}
                    </div>
                    {unmatched.length > 0 && (
                      <div style={{ marginTop: '0.4rem', color: '#94a3b8', fontSize: '0.75rem', maxHeight: '60px', overflowY: 'auto' }}>
                        未找到：{unmatched.map(e => e.name).join('、')}
                      </div>
                    )}
                  </div>
                )}

                {syncResult && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: syncResult.error ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', borderRadius: '8px', fontSize: '0.82rem', border: `1px solid ${syncResult.error ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}` }}>
                    {syncResult.error
                      ? <span style={{ color: '#ef4444' }}>❌ 同步失败：{syncResult.error}</span>
                      : <span style={{ color: '#22c55e' }}>✅ 已成功更新 {syncResult.updatedCount} 个账号密码{syncResult.notFoundCount > 0 ? `，${syncResult.notFoundCount} 个账号名未找到` : ''}</span>
                    }
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                  <button
                    onClick={() => setIsBatchPasswordModalOpen(false)}
                    style={{ padding: '0.5rem 1rem', borderRadius: '7px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', cursor: 'pointer', fontSize: '0.85rem' }}
                  >取消</button>
                  <button
                    onClick={handleSync}
                    disabled={matched.length === 0 || syncing}
                    style={{
                      padding: '0.5rem 1.2rem', borderRadius: '7px', fontSize: '0.85rem', cursor: matched.length === 0 || syncing ? 'not-allowed' : 'pointer',
                      background: matched.length === 0 || syncing ? 'rgba(124,58,237,0.3)' : 'linear-gradient(135deg, #7c3aed, #4f46e5)',
                      border: 'none', color: '#fff', opacity: matched.length === 0 || syncing ? 0.6 : 1
                    }}
                  >
                    {syncing ? '同步中...' : `同步 ${matched.length} 个密码`}
                  </button>
                </div>
              </div>
            </div>
          );
        };

        return <BatchPasswordModal />;
      })()}

      {/* ── 重新登录弹窗 ── */}
      {reloginDialog && (
        <div className="modal-overlay" style={{ zIndex: 99999 }} onClick={() => !reloginDialog.loading && setReloginDialog(null)}>
          <div style={{
            background: 'var(--card-bg, #1e2133)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '12px', padding: '1.5rem', width: '360px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem' }}>🔑 重新登录 — {reloginDialog.acc.name}</h3>
              {!reloginDialog.loading && <button onClick={() => setReloginDialog(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>}
            </div>
            <p style={{ color: '#94a3b8', fontSize: '0.82rem', margin: '0 0 1rem 0', lineHeight: 1.5 }}>
              使用账号密码 + maFile 令牌重新登录 Steam，获取新的 RefreshToken，解决令牌失效问题。
            </p>
            <input
              type="password"
              placeholder="Steam 账号密码"
              value={reloginDialog.password}
              onChange={e => setReloginDialog(prev => ({ ...prev, password: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && !reloginDialog.loading && handleRelogin()}
              disabled={reloginDialog.loading}
              style={{
                width: '100%', padding: '0.6rem 0.8rem', borderRadius: '8px', fontSize: '0.9rem',
                background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
                color: '#f1f5f9', outline: 'none', boxSizing: 'border-box', marginBottom: '0.75rem'
              }}
              autoFocus
            />
            {reloginDialog.error && (
              <div style={{
                background: 'rgba(239,68,68,0.1)', color: '#ef4444', padding: '0.5rem 0.8rem',
                borderRadius: '6px', fontSize: '0.82rem', marginBottom: '0.75rem'
              }}>
                ❌ {reloginDialog.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleRelogin}
                disabled={reloginDialog.loading || !reloginDialog.password}
                style={{
                  flex: 1, padding: '0.6rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
                  background: reloginDialog.loading || !reloginDialog.password ? 'rgba(99,102,241,0.3)' : '#6366f1',
                  color: '#fff', fontWeight: 600, fontSize: '0.9rem'
                }}
              >{reloginDialog.loading ? '⏳ 登录中...' : '🔑 重新登录'}</button>
              {!reloginDialog.loading && (
                <button onClick={() => setReloginDialog(null)} style={{
                  padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)',
                  background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.9rem'
                }}>取消</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 分组封禁检测结果弹窗 ── */}
      {groupBanModal && (
        <div className="modal-overlay" style={{ zIndex: 99999 }} onClick={() => setGroupBanModal(null)}>
          <div className="modal-content glass-effect" onClick={e => e.stopPropagation()}
            style={{ maxWidth: '750px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div className="modal-header">
              <h3>🛡️ 封禁检测 — {groupBanModal.groupName}</h3>
              <button className="close-btn" onClick={() => setGroupBanModal(null)}>×</button>
            </div>

            {groupBanModal.loading && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--accent-color)' }}>
                ⏳ 正在查询 Steam 封禁数据...
              </div>
            )}

            {groupBanModal.error && (
              <div style={{
                background: 'rgba(239,68,68,0.1)', color: '#ef4444', padding: '1rem',
                borderRadius: '0.5rem', border: '1px solid #ef4444'
              }}>
                ❌ {groupBanModal.error}
              </div>
            )}

            {groupBanModal.data && (() => {
              const { total, bannedCount, suspiciousCount, results } = groupBanModal.data;
              let computedSuspiciousCount = suspiciousCount;
              if (computedSuspiciousCount === undefined) {
                computedSuspiciousCount = results.filter(r => !r.isBanned && (r.numberOfGameBans > 0 || r.economyBan === 'probation')).length;
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* 汇总栏 */}
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    {[{ label: '总数', v: total, c: '' },
                    { label: '✅ 正常', v: Math.max(0, total - bannedCount - computedSuspiciousCount), c: '#22c55e' },
                    { label: '🟡 可疑', v: computedSuspiciousCount, c: '#eab308' },
                    { label: '🔴 异常', v: bannedCount, c: '#ef4444' },
                    ].map(({ label, v, c }) => (
                      <div key={label} style={{
                        flex: 1, minWidth: 80, background: 'rgba(255,255,255,0.04)',
                        border: '1px solid var(--glass-border)', borderRadius: '0.75rem',
                        padding: '0.6rem', textAlign: 'center'
                      }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 700, color: c || 'var(--text-main)' }}>{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* 结果表格 */}
                  <div style={{ overflowX: 'auto', border: '1px solid var(--glass-border)', borderRadius: '0.75rem' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
                      <thead>
                        <tr style={{ background: '#1e293b' }}>
                          {['账号名', '🔴 社区封禁', '☣️ VAC封禁', '🟡 游戏封禁', '综合状态'].map(h => (
                            <th key={h} style={{
                              padding: '0.6rem 0.75rem', textAlign: 'left',
                              color: 'var(--text-muted)', borderBottom: '1px solid var(--glass-border)',
                              whiteSpace: 'nowrap'
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r, i) => {
                          const isSusp = r.isSuspicious ?? (!r.isBanned && (r.numberOfGameBans > 0 || r.economyBan === 'probation'));
                          return (
                            <tr key={r.id} style={{ background: r.isBanned ? 'rgba(239,68,68,0.05)' : isSusp ? 'rgba(234,179,8,0.05)' : 'transparent' }}>
                              <td style={{ padding: '0.55rem 0.75rem', fontWeight: 500, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{r.name}</td>
                              <td style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                {r.communityBanned ? <span style={{ color: '#ef4444', fontWeight: 600 }}>🔴 是</span> : <span style={{ color: '#22c55e' }}>✅ 否</span>}
                              </td>
                              <td style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                {r.vacBanned
                                  ? <span style={{ color: '#a855f7', fontWeight: 600 }}>☣️ ×{r.numberOfVACBans}({r.daysSinceLastBan}天前)</span>
                                  : <span style={{ color: '#22c55e' }}>✅ 否</span>}
                              </td>
                              <td style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                {r.numberOfGameBans > 0
                                  ? <span style={{ color: '#eab308', fontWeight: 600 }}>🟡 ×{r.numberOfGameBans}</span>
                                  : <span style={{ color: '#22c55e' }}>✅ 否</span>}
                              </td>
                              <td style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                {r.isBanned ? <span style={{ color: '#ef4444', fontWeight: 600 }}>🔴 无法交易</span> : isSusp ? <span style={{ color: '#eab308', fontWeight: 600 }}>🟡 可疑</span> : <span style={{ color: '#22c55e' }}>✅ 正常</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Global Settings Modal */}
      {isSettingsModalOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsModalOpen(false)}>
          <div className="modal-content glass-effect settings-modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3>⚙️ 系统全局设置</h3>
              <button className="close-btn" onClick={() => setIsSettingsModalOpen(false)}>×</button>
            </div>
            <div className="settings-form-body custom-scrollbar" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '10px' }}>

              <div className="settings-section" style={{ marginBottom: '20px', padding: '15px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px' }}>
                <h4 style={{ margin: '0 0 15px 0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>🔔 钉钉通知设置 (DingTalk)</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <div className="form-group-flex" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <label style={{ fontSize: '0.85rem', opacity: 0.8 }}>Webhook URL:</label>
                    <input style={{ width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '6px', padding: '10px' }} value={dingTalkWebhookInput} onChange={e => setDingTalkWebhookInput(e.target.value)} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
                  </div>
                  <div className="form-group-flex" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <label style={{ fontSize: '0.85rem', opacity: 0.8 }}>通信密钥 (Secret):</label>
                    <input style={{ width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '6px', padding: '10px' }} value={dingTalkSecretInput} onChange={e => setDingTalkSecretInput(e.target.value)} type="password" placeholder="如果是签名校验请填写 Secret" />
                  </div>
                  <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                    <button className="primary-btn btn-sm" onClick={() => updateSettings({ dingTalkWebhook: dingTalkWebhookInput, dingTalkSecret: dingTalkSecretInput })}>保存钉钉配置</button>
                    <button className="secondary-btn btn-sm" onClick={testDingTalk}>发送测试通知</button>
                  </div>
                </div>
              </div>

              <div className="settings-section" style={{ marginBottom: '20px', padding: '15px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px' }}>
                <h4 style={{ margin: '0 0 15px 0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>🌐 代理网络设置</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <div className="form-group-flex" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label style={{ fontSize: '0.85rem', opacity: 0.8 }}>本地 Clash 代理端口:</label>
                    <input style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '6px', padding: '8px', width: '100px' }} type="number" value={settings?.clashProxyPort || 7897} onChange={e => updateSettings({ clashProxyPort: parseInt(e.target.value) || 7897 })} />
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>如果内置代理启动异常，可在此手动指定下行代理混合端口 (留空恢复默认 7897)。</div>
                  
                  <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <label style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>启用 Webshare 动态住宅 IP (防 Steam 429 封禁):</label>
                      <input 
                        type="checkbox" 
                        checked={settings?.webshare?.enabled || false} 
                        onChange={e => updateSettings({ webshare: { ...(settings?.webshare || {}), enabled: e.target.checked } })}
                        style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                      />
                    </div>
                    {settings?.webshare?.enabled && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>代理地址 (Host)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="p.webshare.io" value={settings.webshare.host || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, host: e.target.value }})} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>端口 (Port)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="80" type="number" value={settings.webshare.port || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, port: parseInt(e.target.value) }})} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>账号前缀 (Username Prefix)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="xehleepc-" value={settings.webshare.userPrefix || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, userPrefix: e.target.value }})} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>密码 (Password)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="密码" value={settings.webshare.pass || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, pass: e.target.value }})} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>起始编号 (Min)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="1" type="number" value={settings.webshare.userMin || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, userMin: parseInt(e.target.value) }})} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px' }}>结束编号 (Max)</label>
                          <input style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '6px', borderRadius: '4px' }} placeholder="25" type="number" value={settings.webshare.userMax || ''} onChange={e => updateSettings({ webshare: { ...settings.webshare, userMax: parseInt(e.target.value) }})} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* Account Edit Modal — global layer, works from any tab */}
      {isAccountModalOpen && (
        <div className="modal-overlay" onClick={() => setIsAccountModalOpen(false)}>
          <div className="modal-content glass-effect" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Steam 账号管理</h3>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button className="sync-all-btn" onClick={syncAllAccounts} disabled={isSyncing}
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: isSyncing ? 0.6 : 1 }}>
                  {isSyncing ? '同步处理中...' : '一键同步所有账号'}
                </button>

                <button className="close-btn" onClick={() => setIsAccountModalOpen(false)}>×</button>
              </div>
            </div>
            <div className="account-list-editor">
              {steamAccounts.map(acc => (
                <div className="account-edit-row" key={acc.id}>
                  <div className="edit-main-fields" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div className="edit-field-group">
                        <label>账号名称:</label>
                        <input value={acc.name} placeholder="例如: 大号 / 刷箱号" onChange={e => updateAccount(acc.id, 'name', e.target.value)} />
                      </div>
                      <div className="edit-field-group">
                        <label>SteamID64 (可选):</label>
                        <input value={acc.steamId64 || ''} placeholder="同步时可自动查找" onChange={e => updateAccount(acc.id, 'steamId64', e.target.value)} />
                      </div>
                    </div>
                    <div className="edit-field-group">
                      <label style={{ display: 'block', color: '#c084fc', fontWeight: 'bold', marginBottom: '4px' }}>🔗 关联 C5 商户 (API Key):</label>
                      <CustomSelect
                        value={acc.c5MerchantId || ''}
                        options={[{ label: '--- 未绑定 (使用系统默认) ---', value: '' }, ...merchants.map(m => ({ label: m.isDefault ? `⭐ ${m.name} (默认)` : m.name, value: m.id }))]}
                        onChange={(val) => updateAccount(acc.id, 'c5MerchantId', val || null)}
                        className="full-width"
                      />
                    </div>
                    <div className="edit-field-group" style={{ flex: 1 }}>
                      <label>账号 Steam Cookie (用于购买功能):</label>
                      <input type="password" value={acc.steamCookie || ''} placeholder="粘贴账号专用的 Steam Cookie，否则将无法使用此账号购买"
                        onChange={e => updateAccount(acc.id, 'steamCookie', e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} />
                    </div>
                  </div>
                  <div className="account-wealth-status">
                    <div className="wealth-item">钱包余额: <span>{acc.balance || '¥ 0.00'}</span></div>
                    <div className="wealth-item">库存估算: <span className="inventory-link" onClick={() => fetchInventory(acc.id, acc.name)} title="点击查看详细库存列表">{acc.inventoryValue || '¥ 0.00'}</span></div>
                    <div className="wealth-item" style={{ fontSize: '0.85rem' }}>已上架: <span className="inventory-link" onClick={() => fetchMarketListings(acc.id, acc.name)} style={{ marginLeft: '4px' }} title="查看正在出售中的饰品">查询挂单</span></div>
                    {acc.lastSync && <div className="wealth-item" style={{ fontSize: '0.75rem', opacity: 0.7 }}>上次同步: {new Date(acc.lastSync).toLocaleString()}</div>}
                  </div>
                  <div className="account-row-actions">
                    <button className="secondary-btn" style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }} title="打开独立沙盒窗口进行登录"
                      onClick={() => handleOpenBrowser('https://store.steampowered.com/login/', acc.browserPath, acc.profile, acc.browserType, acc.profilePath)}>
                      点击登录账号
                    </button>
                    <button className={`sync-wealth-btn ${isSyncing && activeAccountId === acc.id ? 'syncing' : ''}`} onClick={() => syncWealth(acc.id)} disabled={isSyncing}>
                      {isSyncing && activeAccountId === acc.id ? '正在同步...' : '同步资产数据'}
                    </button>
                    <button className="delete-acc-btn" onClick={() => deleteAccount(acc.id)}>删除</button>
                  </div>
                </div>
              ))}
              <button className="add-acc-btn" onClick={addAccount}>+ 添加账号</button>
              <div className="profile-hint-box"><p>💡 提示：点击"登录账号"即可在独立沙盒窗口中登录 Steam，互不串号。</p></div>
            </div>
            <div className="modal-footer">
              <button className="primary-btn" onClick={() => setIsAccountModalOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}

      {isC5ImportModalOpen && (
        <div className="modal-overlay" onClick={() => setIsC5ImportModalOpen(false)}>
          <div className="modal-content glass-effect" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📥 批量导入 Steam 账号</h3>
              <button className="close-btn" onClick={() => setIsC5ImportModalOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="import-dropzone">
                <input
                  type="file"
                  multiple
                  accept=".maFile"
                  onChange={e => handleC5Import(Array.from(e.target.files))}
                  id="mafile-upload"
                  style={{ display: 'none' }}
                />
                <label htmlFor="mafile-upload" className="dropzone-label">
                  <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📄</div>
                  <p>点击或拖拽多个 <b>.maFile</b> 文件到此处</p>
                  <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>系统将自动解析 SteamID、刷新 Session 并获取交易链接，保存到数据库</span>
                </label>
              </div>

              {importLogs.length > 0 && (
                <div className="import-live-log custom-scrollbar" style={{ marginTop: '1rem', maxHeight: '340px', overflowY: 'auto' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '0.85rem', fontWeight: 600 }}>
                    {isC5Importing ? (
                      <><div className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px', flexShrink: 0 }} />
                        <span style={{ opacity: 0.8 }}>正在导入 ({importLogs.filter(l => l.status === 'done' || l.status === 'error' || l.status === 'skipped').length} / {importLogs.length})</span></>
                    ) : (
                      <span>✅ 导入完成&nbsp;
                        <span style={{ color: '#10b981' }}>{importLogs.filter(l => l.status === 'done').length} 成功</span>
                        {importLogs.filter(l => l.status === 'skipped').length > 0 && (
                          <span style={{ color: '#f59e0b' }}> / {importLogs.filter(l => l.status === 'skipped').length} 跳过(重复)</span>
                        )}
                        {importLogs.filter(l => l.status === 'error').length > 0 && (
                          <span style={{ color: '#ef4444' }}> / {importLogs.filter(l => l.status === 'error').length} 失败</span>
                        )}
                      </span>
                    )}
                  </div>
                  {importLogs.map((log, i) => {
                    const r = log.result;
                    return (
                      <div key={i} className="import-log-row">
                        <div className="import-log-icon">
                          {log.status === 'pending' && <span style={{ color: '#64748b', fontSize: '1.1rem' }}>○</span>}
                          {log.status === 'processing' && <div className="spinner" style={{ width: '13px', height: '13px', borderWidth: '2px' }} />}
                          {log.status === 'done' && <span>✅</span>}
                          {log.status === 'skipped' && <span>⚠️</span>}
                          {log.status === 'error' && <span>❌</span>}
                        </div>
                        <div className="import-log-body">
                          <div className="import-log-name">{log.name.replace('.maFile', '')}</div>
                          {log.status === 'pending' && <div className="import-log-detail" style={{ opacity: 0.45 }}>等待处理...</div>}
                          {log.status === 'processing' && <div className="import-log-detail" style={{ color: '#38bdf8' }}>{log.detail}</div>}
                          {log.status === 'done' && r && (
                            <div className="import-log-detail" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                              <span style={{ color: '#10b981' }}>✓ 已保存到数据库</span>
                              {r.tradeUrl && <span style={{ color: '#64748b', fontSize: '0.7rem' }}>🔗 TradeURL</span>}
                              {r.steamId && <span style={{ color: '#475569', fontSize: '0.7rem' }}>{r.steamId}</span>}
                            </div>
                          )}
                          {log.status === 'skipped' && (
                            <div className="import-log-detail" style={{ color: '#f59e0b' }}>{log.result?.error || '重复账号，已跳过'}</div>
                          )}
                          {log.status === 'error' && (
                            <div className="import-log-detail" style={{ color: '#ef4444' }}>{log.result?.error || '解析失败'}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="primary-btn" onClick={() => { setIsC5ImportModalOpen(false); setC5ImportResults(null); setImportLogs([]); }}>完成并查看账号</button>
            </div>
          </div>
        </div>
      )}

      {/* C5 Batch Bind Modal */}
      {isC5BatchBindOpen && (
        <div className="modal-overlay" onClick={() => setIsC5BatchBindOpen(false)}>
          <div className="modal-content glass-effect" style={{ maxWidth: '680px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🔗 C5 批量绑定账号</h3>
              <button className="close-btn" onClick={() => setIsC5BatchBindOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: '12px', marginBottom: '1.2rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: '#a855f7' }}>目标 C5 商户:</label>
                  <CustomSelect
                    value={c5BatchBindMerchantId}
                    options={merchants.map(m => ({ label: m.name, value: m.id }))}
                    onChange={(val) => {
                      setC5BatchBindMerchantId(val);
                      const targetM = merchants.find(m => String(m.id) === String(val));
                      if (targetM && targetM.phone) setC5BatchBindPhone(targetM.phone);
                    }}
                    className="full-width"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: '#a855f7' }}>
                    C5 账号绑定的手机号 <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="tel"
                    placeholder="如: 13812345678"
                    value={c5BatchBindPhone}
                    onChange={e => setC5BatchBindPhone(e.target.value)}
                    style={{
                      width: '100%', background: 'rgba(15,23,42,0.7)', border: '1px solid rgba(168,85,247,0.3)',
                      borderRadius: '8px', color: '#e2e8f0', padding: '0.5rem 0.75rem',
                      fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box'
                    }}
                  />
                </div>
              </div>
              <div style={{ marginBottom: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                <label style={{ fontSize: '0.85rem', opacity: 0.7 }}>选择账号 ({c5BatchBindSelected.size} 已选):</label>
                <button className="btn-sm" style={{ fontSize: '0.75rem' }} onClick={() => setC5BatchBindSelected(new Set(steamAccounts.map(a => String(a.id))))}>
                  全选
                </button>
                <button className="btn-sm" style={{ fontSize: '0.75rem' }} onClick={() => setC5BatchBindSelected(new Set())}>
                  清空
                </button>
              </div>
              <div className="custom-scrollbar" style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid rgba(168,85,247,0.2)', borderRadius: '8px', padding: '6px' }}>
                {[...steamAccounts].sort((a, b) => {
                  const aBound = !!a.c5MerchantId;
                  const bBound = !!b.c5MerchantId;
                  if (aBound !== bBound) return aBound ? 1 : -1; // 未绑定的排在前
                  return a.name.localeCompare(b.name, 'zh-CN'); // 按字母顺序/拼音排序
                }).map(acc => {
                  const checked = c5BatchBindSelected.has(String(acc.id));
                  const bindResult = c5BatchBindResults?.find(r => r.id === acc.id);
                  return (
                    <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', borderRadius: '5px', cursor: 'pointer', background: checked ? 'rgba(168,85,247,0.08)' : 'transparent' }}
                      onClick={() => setC5BatchBindSelected(prev => { const s = new Set(prev); s.has(String(acc.id)) ? s.delete(String(acc.id)) : s.add(String(acc.id)); return s; })}>
                      <input type="checkbox" checked={checked} onChange={() => { }} style={{ accentColor: '#a855f7', width: '15px', height: '15px', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: '0.87rem' }}>{acc.name}</span>
                      {acc.c5MerchantId && <span style={{ fontSize: '0.7rem', color: '#10b981', opacity: 0.8 }}>已绑定</span>}
                      {!acc.tradeUrl && <span style={{ fontSize: '0.7rem', color: '#f59e0b', opacity: 0.8 }}>⚠无交易链接</span>}
                      {bindResult && (
                        <span style={{ fontSize: '0.72rem', color: bindResult.success ? '#10b981' : '#ef4444' }}>
                          {bindResult.success ? '✓ 绑定成功' : `✗ ${bindResult.error}`}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer" style={{ gap: '12px' }}>
              <span style={{ fontSize: '0.8rem', opacity: 0.5, flex: 1 }}>⚠ 没有交易链接的账号无法绑定 C5</span>
              <button className="secondary-btn" onClick={() => setIsC5BatchBindOpen(false)}>取消</button>
              <button className="primary-btn" style={{ background: c5BatchBindSelected.size > 0 && c5BatchBindMerchantId && c5BatchBindPhone ? 'linear-gradient(135deg, #7c3aed, #a855f7)' : 'rgba(255,255,255,0.1)' }}
                onClick={handleC5BatchBind} disabled={isC5BatchBindLoading || c5BatchBindSelected.size === 0 || !c5BatchBindMerchantId || !c5BatchBindPhone}>
                {isC5BatchBindLoading ? <><div className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px', display: 'inline-block', marginRight: '6px' }} />绑定中...</> : `🔗 开始绑定 (${c5BatchBindSelected.size} 个账号)`}
              </button>
            </div>
          </div>
        </div>
      )}


      {isMerchantManagerOpen && (
        <div className="modal-overlay" onClick={() => setIsMerchantManagerOpen(false)}>
          <div className="modal-content glass-effect" style={{ maxWidth: '700px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🔑 C5 商户 API Key 管理</h3>
              <button className="close-btn" onClick={() => setIsMerchantManagerOpen(false)}>×</button>
            </div>
            <div className="modal-body custom-scrollbar" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '15px' }}>

              <div className="merchant-list" style={{ marginBottom: '20px' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', opacity: 0.8 }}>当前已配置商户:</div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  {merchants.length === 0 && <div style={{ textAlign: 'center', opacity: 0.5, padding: '20px' }}>暂未添加任何商户</div>}
                  {merchants.map(m => (
                    <div key={m.id} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: 'rgba(255,255,255,0.05)',
                      padding: '12px 15px',
                      borderRadius: '8px',
                      border: m.isDefault ? '1px solid rgba(168, 85, 247, 0.4)' : '1px solid transparent'
                    }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {m.name} {m.isDefault && <span style={{ fontSize: '0.7rem', background: 'var(--accent-color)', color: '#000', padding: '2px 6px', borderRadius: '4px' }}>默认</span>}
                        </span>
                        <span style={{ fontSize: '0.75rem', opacity: 0.5, marginTop: '2px' }}>AppKey: {m.appKey.substring(0, 8)}...{m.appKey.substring(m.appKey.length - 4)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="secondary-btn btn-sm" onClick={() => setMerchantEditForm(m)}>编辑</button>
                        {!m.isDefault && <button className="c5-cancel-btn btn-sm" onClick={() => handleDeleteMerchant(m.id)}>删除</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="merchant-edit-card" style={{ padding: '20px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <h4 style={{ margin: '0 0 15px 0', color: 'var(--accent-color)' }}>{merchantEditForm?.id ? '✏️ 编辑商户信息' : '➕ 添加新 C5 商户'}</h4>
                <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <label style={{ fontSize: '0.85rem', opacity: 0.8 }}>商户备注 (如 "主号"):</label>
                    <input
                      style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '6px', padding: '10px' }}
                      value={merchantEditForm?.name || ''}
                      onChange={e => setMerchantEditForm(pc => ({ ...pc, name: e.target.value }))}
                      placeholder="商户显示名称"
                    />
                  </div>
                  <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <label style={{ fontSize: '0.85rem', opacity: 0.8 }}>API Key (AppKey):</label>
                    <input
                      style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '6px', padding: '10px' }}
                      type="password"
                      value={merchantEditForm?.appKey || ''}
                      onChange={e => setMerchantEditForm(pc => ({ ...pc, appKey: e.target.value }))}
                      placeholder="C5 官网商户后台获取"
                    />
                  </div>
                </div>
                <div style={{ marginTop: '15px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
                    <input
                      type="checkbox"
                      checked={!!merchantEditForm?.isDefault}
                      onChange={e => setMerchantEditForm(pc => ({ ...pc, isDefault: e.target.checked }))}
                      style={{ width: '16px', height: '16px' }}
                    />
                    <span>设置为系统默认商户 (未指定商户的账号将使用此 Key)</span>
                  </label>
                </div>
                <div style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                  {merchantEditForm && (
                    <button className="secondary-btn" onClick={() => setMerchantEditForm(null)} style={{ padding: '8px 20px' }}>取消</button>
                  )}
                  <button className="primary-btn" onClick={() => handleSaveMerchant(merchantEditForm || {})} disabled={!merchantEditForm?.name || !merchantEditForm?.appKey} style={{ padding: '8px 30px' }}>
                    {merchantEditForm?.id ? '保存修改' : '确认添加'}
                  </button>
                </div>
              </div>

            </div>
            <div className="modal-footer" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', padding: '15px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setIsMerchantManagerOpen(false)} style={{ padding: '8px 20px' }}>完成退出</button>
            </div>
          </div>
        </div>
      )}

      {/* Account Group Manager Modal */}
      {isGroupManagerOpen && (
        <div className="modal-overlay" onClick={() => { setIsGroupManagerOpen(false); setGroupEditForm(null); }}>
          <div className="modal-content glass-effect" style={{ maxWidth: '520px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🗂️ 账号分组管理</h3>
              <button className="close-btn" onClick={() => { setIsGroupManagerOpen(false); setGroupEditForm(null); }}>×</button>
            </div>
            <div className="modal-body custom-scrollbar" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '15px' }}>

              {/* Existing Groups */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', opacity: 0.8 }}>当前分组:</div>
                {groups.length === 0 && <div style={{ textAlign: 'center', opacity: 0.5, padding: '20px' }}>暂无分组，点击下方新建</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {groups.map(g => (
                    <div key={g.id} className="group-manager-row">
                      <span className="group-manager-dot" style={{ background: g.color }} />
                      <span className="group-manager-name">{g.name}</span>
                      <span className="group-manager-count">{g.count} 个账号</span>
                      <button className="c5-mini-btn" onClick={() => setGroupEditForm({ id: g.id, name: g.name, color: g.color })}>✏️</button>
                      <button className="c5-mini-delist-btn" onClick={() => handleDeleteGroup(g.id)}>🗑️</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Create / Edit Group Form */}
              <div className="group-form-section">
                <div style={{ fontWeight: 'bold', marginBottom: '10px', opacity: 0.8 }}>
                  {groupEditForm?.id ? '✏️ 编辑分组' : '➕ 新建分组'}
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="c5-trade-url-input"
                    style={{ flex: 1, minWidth: '140px' }}
                    placeholder="分组名称"
                    value={groupEditForm?.name || ''}
                    onChange={e => setGroupEditForm(prev => ({ ...(prev || {}), name: e.target.value }))}
                  />
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {['#667eea', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'].map(c => (
                      <div
                        key={c}
                        onClick={() => setGroupEditForm(prev => ({ ...(prev || {}), color: c }))}
                        style={{
                          width: '20px', height: '20px', borderRadius: '50%', background: c, cursor: 'pointer',
                          border: (groupEditForm?.color || '#667eea') === c ? '3px solid white' : '2px solid transparent',
                          transition: 'transform 0.15s',
                          transform: (groupEditForm?.color || '#667eea') === c ? 'scale(1.3)' : 'scale(1)'
                        }}
                      />
                    ))}
                  </div>
                  <button
                    className="primary-btn"
                    style={{ padding: '6px 16px' }}
                    disabled={!groupEditForm?.name?.trim()}
                    onClick={() => handleSaveGroup(groupEditForm)}
                  >{groupEditForm?.id ? '保存' : '创建'}</button>
                  {groupEditForm?.id && (
                    <button className="secondary-btn" style={{ padding: '6px 12px' }} onClick={() => setGroupEditForm(null)}>取消</button>
                  )}
                </div>
              </div>

            </div>
            <div className="modal-footer" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', padding: '15px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => { setIsGroupManagerOpen(false); setGroupEditForm(null); }} style={{ padding: '8px 20px' }}>完成退出</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
