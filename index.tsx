
import { GoogleGenAI } from "@google/genai";
import React, { useState, useMemo, useEffect, useCallback, Fragment, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement, PointElement, LineElement } from 'chart.js';
import { Bar, Pie, Line } from 'react-chartjs-2';


// --- CHART.JS REGISTRATION ---
ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement, PointElement, LineElement);

// --- CONFIG & CONSTANTS ---
const GOOGLE_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwhTkBDPjOkXxgIUWJtDXzqhpwjETbn6n4T5I-s84t5tY6IFowgN8d5eIpW5S8xGlOz8A/exec';
const LOCAL_STORAGE_ORDERS_KEY = 'takoyaki_pos_completed_orders';
const LOCAL_STORAGE_LOG_KEY = 'takoyaki_pos_activity_log';
const LOCAL_STORAGE_FAVORITES_KEY = 'takoyaki_pos_favorite_ids';
const LOCAL_STORAGE_SHOP_SETTINGS_KEY = 'takoyaki_pos_shop_settings';
const LOCAL_STORAGE_CURRENT_SHIFT_KEY = 'takoyaki_pos_current_shift';
const LOCAL_STORAGE_SHIFT_HISTORY_KEY = 'takoyaki_pos_shift_history';
const SYNC_INTERVAL = 60000; // 60 วินาที

// --- INTERFACES ---
interface MenuItem {
    id: number;
    name: string;
    price: number;
    image: string;
    category: string;
}

interface CartItem extends MenuItem {
    quantity: number;
}

interface Order {
    id: string;
    items: CartItem[];
    subtotal: number;
    tax: number;
    discountValue: number;
    total: number;
    timestamp: Date;
    paymentMethod: 'cash' | 'qr';
    vatRate: number;
    status: 'completed' | 'cancelled';
    cancelledAt?: Date;
    syncStatus: 'pending' | 'synced' | 'failed';
    reversalOf?: string; // Links a reversal bill to the original
}

interface KitchenOrder extends Omit<Order, 'status'> {
    status: 'cooking' | 'ready';
}

interface LogEntry {
    timestamp: Date;
    action: string;
}

interface ShopSettings {
    shopName: string;
    address: string;
    logoUrl: string;
    logoWidth: number;
    logoHeight: number;
    promoUrl: string;
    promoWidth: number;
    promoHeight: number;
    headerText: string;
    footerText: string;
    interactionMode: 'desktop' | 'touch';
    isKeyboardNavEnabled: boolean;
}

interface CashDrawerActivity {
    id: string;
    timestamp: Date;
    type: 'SHIFT_START' | 'SALE' | 'REFUND' | 'PAID_IN' | 'PAID_OUT' | 'SHIFT_END';
    amount: number; // always positive
    paymentMethod: 'cash' | 'qr';
    description: string;
    orderId?: string;
}

interface Shift {
    id: string; // YYYYMMDD-Shift-1
    status: 'OPEN' | 'CLOSED';
    startTime: Date;
    endTime?: Date;
    
    openingFloatAmount: number;

    // All figures below are calculated and stored on closing
    closingCashCounted?: number;
    expectedCashInDrawer?: number;
    cashOverShort?: number;
    
    totalSales?: number;
    totalCashSales?: number;
    totalQrSales?: number;
    totalPaidIn?: number;
    totalPaidOut?: number;
    
    cashToDeposit?: number;
    cashForNextShift?: number;

    // Live data
    activities: CashDrawerActivity[];
}


const TAX_RATE = 0.07;
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

// --- HELPERS ---
const getYYYYMMDD = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
};

// --- APP COMPONENT ---
const App = () => {
    // STATE MANAGEMENT
    const [view, setView] = useState<'pos' | 'orders' | 'reports' | 'settings'>('pos');
    const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
    const [categories, setCategories] = useState<string[]>([]);
    const [activeCategory, setActiveCategory] = useState<string>('');
    const [cart, setCart] = useState<CartItem[]>([]);
    const [completedOrders, setCompletedOrders] = useState<Order[]>([]);
    const [kitchenOrders, setKitchenOrders] = useState<KitchenOrder[]>([]);
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [showReceiptModal, setShowReceiptModal] = useState(false);
    const [receiptData, setReceiptData] = useState<(Order & { cashReceived?: number }) | null>(null);
    const [discount, setDiscount] = useState('');
    const [isVatEnabled, setIsVatEnabled] = useState(false);
    const [favoriteIds, setFavoriteIds] = useState<Set<number>>(new Set());
    const [isOrderPanelOpen, setIsOrderPanelOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [isPlacingOrder, setIsPlacingOrder] = useState(false);
    const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);
    
    // Menu Data State
    const [isMenuLoading, setIsMenuLoading] = useState(true);
    const [menuError, setMenuError] = useState<string | null>(null);

    // Admin & Menu Management State
    const [isAdminMode, setIsAdminMode] = useState(false);
    const [showAdminLoginModal, setShowAdminLoginModal] = useState(false);
    const [adminPassword, setAdminPassword] = useState('1111');
    const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
    const [showMenuItemModal, setShowMenuItemModal] = useState(false);
    const [editingItem, setEditingItem] = useState<MenuItem | null | { category: string }>(null);

    // Shift & Cash Management State
    const [currentShift, setCurrentShift] = useState<Shift | null>(null);
    const [shiftHistory, setShiftHistory] = useState<Shift[]>([]);
    const [showStartShiftModal, setShowStartShiftModal] = useState(false);
    const [showEndShiftModal, setShowEndShiftModal] = useState(false);
    const [showPaidInOutModal, setShowPaidInOutModal] = useState(false);

    // Offline receipt images state
    const [offlineReceiptLogo, setOfflineReceiptLogo] = useState<string | null>(null);
    const [offlineReceiptPromo, setOfflineReceiptPromo] = useState<string | null>(null);

    // Shop & UI State
    const [shopSettings, setShopSettings] = useState<ShopSettings>({
        shopName: "Ultra Max Takoyaki",
        address: "123 ถนนสุขุมวิท, กรุงเทพมหานคร 10110",
        logoUrl: 'https://images.unsplash.com/photo-1595854341625-f33ee135d992?w=80&h=80&auto=format&fit=crop&q=60',
        logoWidth: 80,
        logoHeight: 80,
        promoUrl: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExaDBka3k3bmNkc3k2c2J5dzV0bjg0d3F0dzQ3d2ZkNXI2OGU2aHh2aiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/ARp1qG127zY2I/giphy.gif',
        promoWidth: 200,
        promoHeight: 50,
        headerText: 'ขอบคุณที่ใช้บริการ',
        footerText: 'www.ultramaxtako.com',
        interactionMode: 'desktop',
        isKeyboardNavEnabled: false,
    });
    const [theme, setTheme] = useState<'light' | 'dark'>('light');
    const [zoomLevel, setZoomLevel] = useState(16); // Base font-size in pixels
    const [currentDate, setCurrentDate] = useState('');

    // Keyboard Navigation State & Refs
    const [focusedItem, setFocusedItem] = useState<{ pane: 'categories' | 'menu'; index: number } | null>(null);
    const categoryItemRefs = useRef(new Map<string, HTMLLIElement>());
    const menuItemRefs = useRef(new Map<number, HTMLDivElement>());
    const menuGridRef = useRef<HTMLDivElement>(null);
    const getCategoryItemRef = (cat: string) => (el: HTMLLIElement | null) => {
        if (el) categoryItemRefs.current.set(cat, el); else categoryItemRefs.current.delete(cat);
    };
    const getMenuItemRef = (id: number) => (el: HTMLDivElement | null) => {
        if (el) menuItemRefs.current.set(id, el); else menuItemRefs.current.delete(id);
    };
    
    // HANDLERS
    const logAction = useCallback((action: string) => {
        setActivityLog(prev => [{ timestamp: new Date(), action }, ...prev.slice(0, 199)]);
    }, []);

    const fetchMenuData = useCallback(async () => {
        setIsMenuLoading(true);
        setMenuError(null);
        if (!GOOGLE_SHEET_WEB_APP_URL || !GOOGLE_SHEET_WEB_APP_URL.startsWith('https://script.google.com/macros/s/')) {
            setMenuError('กรุณาตั้งค่า Google Sheet Web App URL ที่ถูกต้องในไฟล์ index.tsx');
            setIsMenuLoading(false);
            console.error("Google Sheet Web App URL is not set or is a placeholder.");
            return;
        }

        try {
            const response = await fetch(`${GOOGLE_SHEET_WEB_APP_URL}?action=getMenu`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            if (data.status === 'success') {
                const formattedMenuItems = data.menuItems.map((item: any) => ({
                    ...item,
                    id: Number(item.id),
                    price: parseFloat(item.price) || 0,
                }));

                setMenuItems(formattedMenuItems);
                setCategories(data.categories);
                if (data.categories.length > 0 && activeCategory === '') {
                    setActiveCategory(data.categories[0]);
                }
                logAction('โหลดข้อมูลเมนูจาก Google Sheet สำเร็จ');
            } else {
                throw new Error(data.message || 'เกิดข้อผิดพลาดในการดึงข้อมูลเมนู');
            }
        } catch (error) {
            console.error("Failed to fetch menu data:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            setMenuError(`ไม่สามารถโหลดเมนูได้: ${errorMessage}`);
            logAction(`ผิดพลาดในการโหลดเมนู: ${errorMessage}`);
        } finally {
            setIsMenuLoading(false);
        }
    }, [logAction, activeCategory]);

    const syncOrders = useCallback(async () => {
        if (!GOOGLE_SHEET_WEB_APP_URL || !GOOGLE_SHEET_WEB_APP_URL.startsWith('https://script.google.com/macros/s/')) {
            console.error("Google Sheet Web App URL is not set. Please update the constant in index.tsx.");
            setCompletedOrders(currentOrders => 
                currentOrders.map(o => o.syncStatus === 'pending' ? { ...o, syncStatus: 'failed' as const } : o)
            );
            return;
        }

        let ordersToSync: Order[] = [];
        setCompletedOrders(currentOrders => {
            ordersToSync = currentOrders.filter(o => o.syncStatus === 'pending' || o.syncStatus === 'failed');
            return currentOrders;
        });

        if (ordersToSync.length === 0) return;
        logAction(`กำลังซิงค์ข้อมูล ${ordersToSync.length} บิลที่ค้างอยู่...`);

        const syncPromises = ordersToSync.map(async (order) => {
            try {
                const response = await fetch(GOOGLE_SHEET_WEB_APP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'saveOrder', order }),
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const result = await response.json();
                if (result.status !== 'success') throw new Error(`Apps Script Error: ${result.message || 'Unknown error'}`);
                
                return { id: order.id, status: 'synced' as const };
            } catch (error) {
                console.error(`Failed to sync order #${order.id}:`, error);
                return { id: order.id, status: 'failed' as const };
            }
        });

        const results = await Promise.all(syncPromises);

        setCompletedOrders(prevOrders => {
            const newOrders = [...prevOrders];
            let syncedCount = 0;
            results.forEach(result => {
                const orderIndex = newOrders.findIndex(o => o.id === result.id);
                if (orderIndex !== -1 && newOrders[orderIndex].syncStatus !== result.status) {
                    newOrders[orderIndex].syncStatus = result.status;
                    if (result.status === 'synced') syncedCount++;
                }
            });
            if (syncedCount > 0) logAction(`ซิงค์ข้อมูลสำเร็จ ${syncedCount} บิล`);
            return newOrders;
        });
    }, [logAction]);

    // DERIVED STATE & MEMOS
    const navCategories = useMemo(() => ['รายการโปรด', ...categories], [categories]);
    
    const filteredMenuItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        // When searching, reset keyboard focus
        if (query !== '') {
            if (focusedItem?.pane === 'menu') setFocusedItem(null);
            return menuItems.filter(item => item.name.toLowerCase().includes(query));
        }
        if (activeCategory === 'รายการโปรด') {
            return menuItems.filter(item => favoriteIds.has(item.id));
        }
        return menuItems.filter(item => item.category === activeCategory);
    }, [menuItems, activeCategory, favoriteIds, searchQuery, focusedItem]);
    
    // --- LOCAL STORAGE PERSISTENCE & APP INITIALIZATION ---
    useEffect(() => {
        document.body.className = theme;
        setCurrentDate(new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }));
        
        try {
            // Orders
            const savedOrdersJSON = localStorage.getItem(LOCAL_STORAGE_ORDERS_KEY);
            if (savedOrdersJSON) {
                setCompletedOrders(JSON.parse(savedOrdersJSON).map((o: Order) => ({ ...o, timestamp: new Date(o.timestamp), cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : undefined, syncStatus: o.syncStatus || 'synced' })));
            }
            // Log
            const savedLogJSON = localStorage.getItem(LOCAL_STORAGE_LOG_KEY);
            if (savedLogJSON) setActivityLog(JSON.parse(savedLogJSON).map((l: LogEntry) => ({...l, timestamp: new Date(l.timestamp)})));
            // Favorites
            const savedFavoritesJSON = localStorage.getItem(LOCAL_STORAGE_FAVORITES_KEY);
            if (savedFavoritesJSON) setFavoriteIds(new Set(JSON.parse(savedFavoritesJSON)));
            // Settings
            const savedSettingsJSON = localStorage.getItem(LOCAL_STORAGE_SHOP_SETTINGS_KEY);
            if (savedSettingsJSON) setShopSettings(prev => ({ ...prev, ...JSON.parse(savedSettingsJSON) }));
            // Shifts
            const savedCurrentShiftJSON = localStorage.getItem(LOCAL_STORAGE_CURRENT_SHIFT_KEY);
            if (savedCurrentShiftJSON) {
                const parsedShift = JSON.parse(savedCurrentShiftJSON);
                setCurrentShift({ ...parsedShift, startTime: new Date(parsedShift.startTime), activities: parsedShift.activities.map((a: CashDrawerActivity) => ({...a, timestamp: new Date(a.timestamp)})) });
            }
            const savedShiftHistoryJSON = localStorage.getItem(LOCAL_STORAGE_SHIFT_HISTORY_KEY);
            if(savedShiftHistoryJSON) {
                setShiftHistory(JSON.parse(savedShiftHistoryJSON).map((s: Shift) => ({...s, startTime: new Date(s.startTime), endTime: s.endTime ? new Date(s.endTime) : undefined, activities: s.activities.map((a: CashDrawerActivity) => ({...a, timestamp: new Date(a.timestamp)}))})));
            }
            // Offline receipt images
            const savedOfflineLogo = localStorage.getItem('takoyaki_pos_offline_logo');
            if (savedOfflineLogo) setOfflineReceiptLogo(savedOfflineLogo);
            
            const savedOfflinePromo = localStorage.getItem('takoyaki_pos_offline_promo');
            if (savedOfflinePromo) setOfflineReceiptPromo(savedOfflinePromo);


            logAction("แอปพลิเคชันเริ่มต้นและโหลดข้อมูลจากหน่วยความจำสำเร็จ");
            
            fetchMenuData();

        } catch (error) {
            console.error("Failed to load data from localStorage", error);
            logAction("ผิดพลาดในการโหลดข้อมูลจากหน่วยความจำเครื่อง");
        } finally {
            setIsInitialLoadComplete(true);
        }
    }, []); // Runs once on mount. fetchMenuData is stable.

    // Sync on initial load and periodically
    useEffect(() => {
        if (isInitialLoadComplete) {
            syncOrders();
            const intervalId = setInterval(syncOrders, SYNC_INTERVAL);
            return () => clearInterval(intervalId);
        }
    }, [isInitialLoadComplete, syncOrders]);

    // Save data to localStorage whenever it changes
    useEffect(() => { if (isInitialLoadComplete && completedOrders.length > 0) localStorage.setItem(LOCAL_STORAGE_ORDERS_KEY, JSON.stringify(completedOrders.slice(0, 200))); }, [completedOrders, isInitialLoadComplete]);
    useEffect(() => { if (isInitialLoadComplete && activityLog.length > 0) localStorage.setItem(LOCAL_STORAGE_LOG_KEY, JSON.stringify(activityLog.slice(0, 200))); }, [activityLog, isInitialLoadComplete]);
    useEffect(() => { if (isInitialLoadComplete) localStorage.setItem(LOCAL_STORAGE_FAVORITES_KEY, JSON.stringify(Array.from(favoriteIds))); }, [favoriteIds, isInitialLoadComplete]);
    useEffect(() => { if (isInitialLoadComplete) localStorage.setItem(LOCAL_STORAGE_SHOP_SETTINGS_KEY, JSON.stringify(shopSettings)); }, [shopSettings, isInitialLoadComplete]);
    useEffect(() => { if (isInitialLoadComplete) localStorage.setItem(LOCAL_STORAGE_SHIFT_HISTORY_KEY, JSON.stringify(shiftHistory)); }, [shiftHistory, isInitialLoadComplete]);
    useEffect(() => {
        if (isInitialLoadComplete) {
            if (currentShift) {
                localStorage.setItem(LOCAL_STORAGE_CURRENT_SHIFT_KEY, JSON.stringify(currentShift));
            } else {
                localStorage.removeItem(LOCAL_STORAGE_CURRENT_SHIFT_KEY);
            }
        }
    }, [currentShift, isInitialLoadComplete]);

    // Handle UI changes
    useEffect(() => { document.body.className = theme; }, [theme]);
    useEffect(() => { document.documentElement.style.fontSize = `${zoomLevel}px`; }, [zoomLevel]);
    
    // --- Keyboard Navigation Effects ---
    useEffect(() => {
        if (focusedItem?.pane === 'menu' && focusedItem.index >= filteredMenuItems.length) {
            setFocusedItem({ pane: 'menu', index: Math.max(0, filteredMenuItems.length - 1) });
        }
    }, [filteredMenuItems, focusedItem]);

    useEffect(() => {
        if (!focusedItem || !shopSettings.isKeyboardNavEnabled) return;
    
        let element;
        if (focusedItem.pane === 'categories') {
            const key = navCategories[focusedItem.index];
            element = categoryItemRefs.current.get(key);
        } else if (focusedItem.pane === 'menu') {
            const key = filteredMenuItems[focusedItem.index]?.id;
            if (key) {
                element = menuItemRefs.current.get(key);
            }
        }
    
        element?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest',
        });
    }, [focusedItem, navCategories, filteredMenuItems, shopSettings.isKeyboardNavEnabled]);

    const addToCart = useCallback((item: MenuItem) => {
        if (isAdminMode) return;
        setCart(prev => {
            const existing = prev.find(i => i.id === item.id);
            if (existing) {
                return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
            }
            return [...prev, { ...item, quantity: 1 }];
        });
    }, [isAdminMode]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Stop if any modal is open, but allow Escape to close them
            if (showPaymentModal || showReceiptModal || showAdminLoginModal || showMenuItemModal || showStartShiftModal || showEndShiftModal || showPaidInOutModal) {
                 if (e.key === 'Escape') {
                    setShowPaymentModal(false);
                    setShowReceiptModal(false);
                    setShowAdminLoginModal(false);
                    setShowMenuItemModal(false);
                    setShowStartShiftModal(false);
                    setShowEndShiftModal(false);
                    setShowPaidInOutModal(false);
                }
                return;
            }
    
            const target = e.target as HTMLElement;
            const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
            
            // Let Tab do its default thing.
            if (e.key === 'Tab') {
                return;
            }
    
            // Special handling for Escape in search input (works regardless of keyboard nav setting)
            if (e.key === 'Escape' && isInputFocused && target.classList.contains('menu-search-input')) {
                setSearchQuery('');
                (target as HTMLInputElement).blur();
                e.preventDefault();
                return;
            }
            
            // If keyboard nav is disabled, stop here.
            if (!shopSettings.isKeyboardNavEnabled) {
                return;
            }

            // Don't interfere with typing in other inputs when keyboard nav is enabled.
            if (isInputFocused) {
                return;
            }
    
            // If no pane is actively focused for navigation, do nothing.
            if (!focusedItem) return;
            
            // Only handle specific navigation keys from here.
            const handledKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];
            if (!handledKeys.includes(e.key)) {
                return;
            }
            
            e.preventDefault();
    
            let newIndex = focusedItem.index;
    
            if (focusedItem.pane === 'categories') {
                const total = navCategories.length;
                if (e.key === 'ArrowDown') newIndex = (newIndex + 1) % total;
                else if (e.key === 'ArrowUp') newIndex = (newIndex - 1 + total) % total;
                else if (e.key === 'Enter') {
                    setActiveCategory(navCategories[newIndex]);
                    setSearchQuery('');
                    menuGridRef.current?.focus();
                } else if (e.key === 'ArrowRight') {
                    menuGridRef.current?.focus();
                }
                setFocusedItem({ ...focusedItem, index: newIndex });
            } 
            else if (focusedItem.pane === 'menu') {
                const total = filteredMenuItems.length;
                if (total === 0) {
                    if(e.key === 'ArrowLeft') {
                        const categoryListEl = categoryItemRefs.current.get(activeCategory)?.parentElement;
                        if (categoryListEl) {
                            (categoryListEl as HTMLElement).focus();
                        }
                    }
                    return;
                }
    
                const grid = menuGridRef.current;
                const numColumns = grid ? Math.max(1, window.getComputedStyle(grid).gridTemplateColumns.split(' ').length) : 1;
    
                if (e.key === 'ArrowLeft') {
                    if (newIndex % numColumns === 0) {
                         const categoryListEl = categoryItemRefs.current.get(activeCategory)?.parentElement;
                         if (categoryListEl) {
                             (categoryListEl as HTMLElement).focus();
                         }
                    } else {
                        newIndex = Math.max(0, newIndex - 1);
                    }
                }
                else if (e.key === 'ArrowRight') newIndex = Math.min(total - 1, newIndex + 1);
                else if (e.key === 'ArrowDown') newIndex = Math.min(total - 1, newIndex + numColumns);
                else if (e.key === 'ArrowUp') newIndex = Math.max(0, newIndex - numColumns);
                else if (e.key === 'Enter') {
                    const item = filteredMenuItems[newIndex];
                    if (item) addToCart(item);
                }
                setFocusedItem({ ...focusedItem, index: newIndex });
            }
        };
    
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        focusedItem, navCategories, filteredMenuItems, addToCart, activeCategory, searchQuery,
        showPaymentModal, showReceiptModal, showAdminLoginModal, showMenuItemModal, 
        showStartShiftModal, showEndShiftModal, showPaidInOutModal, shopSettings.isKeyboardNavEnabled
    ]);

    const cartCalculations = useMemo(() => {
        const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const discountValue = (discount.endsWith('%')
            ? subtotal * (parseFloat(discount.slice(0, -1)) / 100)
            : parseFloat(discount) || 0);
        const discountedSubtotal = subtotal - discountValue;
        const tax = isVatEnabled ? discountedSubtotal * TAX_RATE : 0;
        const total = discountedSubtotal + tax;
        return { subtotal, tax, discountValue, total: total < 0 ? 0 : total };
    }, [cart, discount, isVatEnabled]);
    
    const cartItemCount = useMemo(() => cart.reduce((sum, item) => sum + item.quantity, 0), [cart]);
    
    const shiftSummaryData = useMemo(() => {
        if (!currentShift) return null;
    
        const summary = {
            totalSales: 0,
            totalCashSales: 0,
            totalQrSales: 0,
            totalPaidIn: 0,
            totalPaidOut: 0, // from REFUND and PAID_OUT
            expectedCashInDrawer: currentShift.openingFloatAmount,
        };
    
        for (const act of currentShift.activities) {
            switch (act.type) {
                case 'SALE':
                    summary.totalSales += act.amount;
                    if (act.paymentMethod === 'cash') summary.totalCashSales += act.amount;
                    else if (act.paymentMethod === 'qr') summary.totalQrSales += act.amount;
                    break;
                case 'REFUND':
                    if (act.paymentMethod === 'cash') summary.totalPaidOut += act.amount;
                    break;
                case 'PAID_IN':
                    summary.totalPaidIn += act.amount;
                    break;
                case 'PAID_OUT':
                    summary.totalPaidOut += act.amount;
                    break;
            }
        }
        
        summary.expectedCashInDrawer = currentShift.openingFloatAmount + summary.totalCashSales + summary.totalPaidIn - summary.totalPaidOut;
    
        return summary;
    }, [currentShift]);

    // --- CORE HANDLERS ---
    
    const updateQuantity = (itemId: number, delta: number) => {
        setCart(prev => {
            const item = prev.find(i => i.id === itemId);
            if (item && item.quantity + delta <= 0) {
                return prev.filter(i => i.id !== itemId);
            }
            return prev.map(i => i.id === itemId ? { ...i, quantity: i.quantity + delta } : i);
        });
    };
    
    const clearCart = () => {
        setCart([]);
        setDiscount('');
        setIsVatEnabled(false);
    };

    const generateNewDailyId = useCallback((allOrders: Order[]): string => {
        const todayStr = getYYYYMMDD(new Date());
        const todaysOrders = allOrders.filter(o => o.id.startsWith(todayStr));
        const nextIdNumber = (todaysOrders.length > 0 ? Math.max(...todaysOrders.map(o => parseInt(o.id.split('-')[1], 10) || 0)) : 0) + 1;
        return `${todayStr}-${String(nextIdNumber).padStart(4, '0')}`;
    }, []);

    const handlePlaceOrder = (paymentMethod: 'cash' | 'qr', cashReceived?: number) => {
        if (cart.length === 0) return;
    
        const { subtotal, tax, discountValue, total } = cartCalculations;
        
        const newOrderId = generateNewDailyId(completedOrders);
        
        const newOrder: Order = {
            id: newOrderId,
            items: cart,
            subtotal, tax, discountValue, total,
            timestamp: new Date(),
            paymentMethod,
            vatRate: isVatEnabled ? TAX_RATE : 0,
            status: 'completed',
            syncStatus: 'pending'
        };
    
        setCompletedOrders(prev => [newOrder, ...prev].sort((a,b) => b.id.localeCompare(a.id)));
        const newKitchenOrder: KitchenOrder = { ...newOrder, status: 'cooking' };
        setKitchenOrders(prev => [...prev, newKitchenOrder].sort((a,b) => a.id.localeCompare(b.id)));
        
        logAction(`บันทึกบิล #${newOrder.id} (สถานะ: รอส่งข้อมูล)`);
        
        // --- Add financial activity to current shift ---
        if (currentShift && currentShift.status === 'OPEN') {
            const saleActivity: CashDrawerActivity = {
                id: `act-${Date.now()}`,
                timestamp: new Date(),
                type: 'SALE',
                amount: newOrder.total,
                paymentMethod: newOrder.paymentMethod,
                description: `Bill #${newOrder.id}`,
                orderId: newOrder.id,
            };
            setCurrentShift(prev => prev ? {...prev, activities: [...prev.activities, saleActivity]} : null);
        }
        // ---------------------------------------------

        setShowPaymentModal(false);
        setIsOrderPanelOpen(false);
        setReceiptData({ ...newOrder, cashReceived });
        setShowReceiptModal(true);
        
        clearCart();
        setTimeout(() => syncOrders(), 100);
    };

    const handleUpdateOrderStatus = (orderId: string, status: 'cooking' | 'ready') => {
        setKitchenOrders(prevOrders =>
            prevOrders.map(order =>
                order.id === orderId ? { ...order, status } : order
            )
        );
    };

    const handleCompleteOrder = (orderId: string) => {
        setKitchenOrders(prevOrders => prevOrders.filter(order => order.id !== orderId));
    };

    const toggleFavorite = (itemId: number) => {
        setFavoriteIds(prev => {
            const newFavs = new Set(prev);
            if (newFavs.has(itemId)) {
                newFavs.delete(itemId);
            } else {
                newFavs.add(itemId);
            }
            return newFavs;
        });
    };
    
    const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 1, 24));
    const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 1, 12));
    const toggleTheme = () => setTheme(prev => (prev === 'light' ? 'dark' : 'light'));

    // --- Admin Handlers (with Google Sheet Sync) ---
    const syncMenuChange = async (action: string, payload: object) => {
        if (!GOOGLE_SHEET_WEB_APP_URL || !GOOGLE_SHEET_WEB_APP_URL.startsWith('https://script.google.com/macros/s/')) {
            const errorMsg = 'Google Sheet URL ไม่ได้ตั้งค่า การเปลี่ยนแปลงจะถูกบันทึกแค่ในเครื่องเท่านั้น';
            console.error(errorMsg);
            alert(errorMsg);
            return { status: 'error', message: errorMsg };
        }

        try {
            const response = await fetch(GOOGLE_SHEET_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action, ...payload }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message || 'Unknown Apps Script error');
            logAction(`ซิงค์สำเร็จ: ${action}`);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to sync menu change (${action}):`, error);
            logAction(`ผิดพลาดในการซิงค์ข้อมูล: ${action} - ${errorMessage}`);
            alert(`เกิดข้อผิดพลาดในการบันทึกข้อมูลไปยัง Google Sheet: ${errorMessage}\n\nการเปลี่ยนแปลงถูกบันทึกในแอปชั่วคราว แต่จะไม่แสดงผลถาวรจนกว่าจะเชื่อมต่อสำเร็จ`);
            return { status: 'error', message: errorMessage };
        }
    };

    const handleAdminLogin = (password: string) => {
        if (password === adminPassword) {
            setIsAdminMode(true);
            setShowAdminLoginModal(false);
            logAction('เข้าสู่ระบบผู้ดูแล');
            return true;
        }
        return false;
    };

    const handleAdminLogout = () => {
        setIsAdminMode(false);
        logAction('ออกจากระบบผู้ดูแล');
    };

    const handlePasswordChange = (newPassword: string): boolean => {
        setAdminPassword(newPassword);
        logAction('เปลี่ยนรหัสผ่านผู้ดูแล');
        alert('เปลี่ยนรหัสผ่านสำเร็จ!');
        return true;
    };

    const handleOpenMenuItemModal = (item: MenuItem | null, category?: string) => {
        if (!isAdminMode) return;
        setEditingItem(item || { category: category || '' });
        setShowMenuItemModal(true);
    };
    
    const handleSaveMenuItem = async (itemToSave: MenuItem) => {
        const isNew = !('id' in itemToSave && itemToSave.id);
        setShowMenuItemModal(false);
        setEditingItem(null);

        if (isNew) {
            const tempId = Date.now();
            const newItem = { ...itemToSave, id: tempId };
            setMenuItems(prev => [...prev, newItem]);
            logAction(`เพิ่มสินค้าใหม่ '${newItem.name}' (กำลังรอการยืนยัน)`);

            const result = await syncMenuChange('addMenuItem', { item: itemToSave });

            if (result.status === 'success' && result.item) {
                const finalItem = { ...result.item, price: parseFloat(result.item.price) };
                setMenuItems(prev => prev.map(item => (item.id === tempId ? finalItem : item)));
                logAction(`ยืนยันการเพิ่มสินค้า '${finalItem.name}' (ID: ${finalItem.id})`);
            } else {
                setMenuItems(prev => prev.filter(item => item.id !== tempId));
                logAction(`ล้มเหลวในการเพิ่มสินค้า '${newItem.name}'`);
            }
        } else {
            const originalItem = menuItems.find(i => i.id === itemToSave.id);
            if (!originalItem) return;
            setMenuItems(prev => prev.map(item => (item.id === itemToSave.id ? itemToSave : item)));
            logAction(`แก้ไขสินค้า '${itemToSave.name}' (ID: ${itemToSave.id})`);

            const result = await syncMenuChange('updateMenuItem', { item: itemToSave });

            if (result.status !== 'success') {
                setMenuItems(prev => prev.map(item => (item.id === itemToSave.id ? originalItem : item)));
                logAction(`ล้มเหลวในการแก้ไขสินค้า '${itemToSave.name}'`);
            }
        }
    };

    const handleDeleteItem = async (itemId: number) => {
        if (!isAdminMode) return;
        const itemToDelete = menuItems.find(item => item.id === itemId);
        if (itemToDelete && window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบสินค้า '${itemToDelete.name}'?`)) {
            const originalItems = [...menuItems];
            setMenuItems(prev => prev.filter(item => item.id !== itemId));
            logAction(`ลบสินค้า '${itemToDelete.name}' (ID: ${itemId}).`);

            const result = await syncMenuChange('deleteMenuItem', { itemId });
            if (result.status !== 'success') {
                setMenuItems(originalItems);
                logAction(`ล้มเหลวในการลบสินค้า '${itemToDelete.name}'`);
            }
        }
    };

    const handleAddCategory = async () => {
        if (!isAdminMode) return;
        const newCategoryName = prompt('กรุณาใส่ชื่อหมวดหมู่ใหม่:');
        if (newCategoryName && newCategoryName.trim() !== '') {
            const trimmedName = newCategoryName.trim();
            if (categories.includes(trimmedName)) {
                alert('มีหมวดหมู่นี้อยู่แล้ว');
                return;
            }
            const originalCategories = [...categories];
            setCategories(prev => [...prev, trimmedName]);
            logAction(`เพิ่มหมวดหมู่ใหม่: '${trimmedName}'.`);

            const result = await syncMenuChange('addCategory', { category: trimmedName });
            if (result.status !== 'success') {
                setCategories(originalCategories);
                logAction(`ล้มเหลวในการเพิ่มหมวดหมู่ '${trimmedName}'`);
            }
        }
    };
    
    const handleDeleteCategory = async (categoryToDelete: string) => {
        if (!isAdminMode) return;
        const itemsInCategory = menuItems.filter(item => item.category === categoryToDelete);
        if (itemsInCategory.length > 0) {
            alert(`ไม่สามารถลบหมวดหมู่ '${categoryToDelete}' ได้ เนื่องจากยังมีสินค้าอยู่ ${itemsInCategory.length} รายการ`);
            return;
        }
        if (window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบหมวดหมู่ '${categoryToDelete}'? การกระทำนี้ไม่สามารถย้อนกลับได้`)) {
            const originalCategories = [...categories];
            setCategories(prev => prev.filter(cat => cat !== categoryToDelete));
            logAction(`ลบหมวดหมู่: '${categoryToDelete}'.`);
            
            const result = await syncMenuChange('deleteCategory', { category: categoryToDelete });
            if (result.status !== 'success') {
                setCategories(originalCategories);
                logAction(`ล้มเหลวในการลบหมวดหมู่ '${categoryToDelete}'`);
            }
        }
    };

    const handleCancelBill = useCallback((orderToCancel: Order) => {
        if (!isAdminMode || orderToCancel.status === 'cancelled') return;
    
        if (window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการยกเลิกบิล #${orderToCancel.id}? การกระทำนี้จะสร้างบิลติดลบเพื่อปรับยอดขาย`)) {

            // --- Add financial REFUND activity to current shift ---
            if (currentShift && currentShift.status === 'OPEN') {
                const refundActivity: CashDrawerActivity = {
                    id: `act-${Date.now()}`,
                    timestamp: new Date(),
                    type: 'REFUND',
                    amount: orderToCancel.total, // The original positive amount
                    paymentMethod: orderToCancel.paymentMethod,
                    description: `Bill cancellation #${orderToCancel.id}`,
                    orderId: orderToCancel.id,
                };
                setCurrentShift(prev => prev ? {...prev, activities: [...prev.activities, refundActivity]} : null);
                logAction(`บันทึกการคืนเงินสำหรับบิล #${orderToCancel.id} ในกะปัจจุบัน`);
            }
            // ----------------------------------------------------
            
            setCompletedOrders(prevOrders => {
                const reversalId = generateNewDailyId(prevOrders);
                const reversalOrder: Order = {
                    id: reversalId,
                    items: [...orderToCancel.items],
                    subtotal: -orderToCancel.subtotal,
                    tax: -orderToCancel.tax,
                    discountValue: orderToCancel.discountValue,
                    total: -orderToCancel.total,
                    timestamp: new Date(),
                    paymentMethod: orderToCancel.paymentMethod,
                    vatRate: orderToCancel.vatRate,
                    status: 'completed',
                    syncStatus: 'pending',
                    reversalOf: orderToCancel.id,
                };

                logAction(`ยกเลิกบิล #${orderToCancel.id} และสร้างใบคืน #${reversalId} ยอดรวม ฿${reversalOrder.total.toFixed(2)}`);

                const updatedOrders = prevOrders.map(order => order.id === orderToCancel.id ? { ...order, status: 'cancelled' as const, cancelledAt: new Date(), syncStatus: 'pending' as const } : order);
                
                return [reversalOrder, ...updatedOrders].sort((a,b) => b.id.localeCompare(a.id));
            });
    
            setTimeout(() => syncOrders(), 100);
        }
    }, [isAdminMode, logAction, syncOrders, generateNewDailyId, currentShift]);

    // --- Shift & Cash Management Handlers ---
    const handleStartShift = (openingFloat: number) => {
        const todayStr = getYYYYMMDD(new Date());
        const todayShifts = shiftHistory.filter(s => s.id.startsWith(todayStr));
        const newShift: Shift = {
            id: `${todayStr}-S${todayShifts.length + 1}`,
            status: 'OPEN',
            startTime: new Date(),
            openingFloatAmount: openingFloat,
            activities: [
                {
                    id: `act-${Date.now()}`,
                    timestamp: new Date(),
                    type: 'SHIFT_START',
                    amount: openingFloat,
                    paymentMethod: 'cash',
                    description: 'เงินทอนเริ่มต้นกะ'
                }
            ]
        };
        setCurrentShift(newShift);
        setShowStartShiftModal(false);
        logAction(`เปิดกะใหม่ #${newShift.id} ด้วยเงินเริ่มต้น ฿${openingFloat.toFixed(2)}`);
    };

    const handlePaidInOut = (activity: { type: 'PAID_IN' | 'PAID_OUT', amount: number, description: string }) => {
        if (!currentShift) return;
        const newActivity: CashDrawerActivity = {
            id: `act-${Date.now()}`,
            timestamp: new Date(),
            type: activity.type,
            amount: activity.amount,
            paymentMethod: 'cash',
            description: activity.description
        };
        setCurrentShift(prev => prev ? {...prev, activities: [...prev.activities, newActivity]} : null);
        setShowPaidInOutModal(false);
        logAction(`${activity.type === 'PAID_IN' ? 'นำเงินเข้า' : 'นำเงินออก'} ฿${activity.amount.toFixed(2)}: ${activity.description}`);
    };
    
    const handleEndShift = (endShiftData: { counted: number, nextShift: number }) => {
        if (!currentShift || !shiftSummaryData) return;

        const { counted, nextShift } = endShiftData;
        const summary = shiftSummaryData;
        const overShort = counted - summary.expectedCashInDrawer;
        const toDeposit = counted - nextShift;

        const closedShift: Shift = {
            ...currentShift,
            status: 'CLOSED',
            endTime: new Date(),
            closingCashCounted: counted,
            expectedCashInDrawer: summary.expectedCashInDrawer,
            cashOverShort: overShort,
            cashForNextShift: nextShift,
            cashToDeposit: toDeposit,
            totalSales: summary.totalSales,
            totalCashSales: summary.totalCashSales,
            totalQrSales: summary.totalQrSales,
            totalPaidIn: summary.totalPaidIn,
            totalPaidOut: summary.totalPaidOut,
            activities: [
                ...currentShift.activities,
                {
                    id: `act-${Date.now()}`,
                    timestamp: new Date(),
                    type: 'SHIFT_END',
                    amount: counted,
                    paymentMethod: 'cash',
                    description: 'ปิดยอด สรุปเงินสดในลิ้นชัก'
                }
            ]
        };

        setShiftHistory(prev => [closedShift, ...prev]);
        setCurrentShift(null);
        setShowEndShiftModal(false);
        logAction(`ปิดกะ #${closedShift.id}. เงินขาด/เกิน: ฿${overShort.toFixed(2)}`);
    };


    // RENDER COMPONENTS
    const TopNav = () => (
        <nav className="top-nav">
            <div className="logo">Ultra Max Pos Ver 0.2</div>
            <div className="nav-buttons">
                <button className={`nav-button ${view === 'pos' ? 'active' : ''}`} onClick={() => setView('pos')}>
                    <span className="material-symbols-outlined">point_of_sale</span> <span>ขาย</span>
                </button>
                <button className={`nav-button ${view === 'orders' ? 'active' : ''}`} onClick={() => setView('orders')}>
                    <span className="material-symbols-outlined">receipt_long</span> <span>บิลขาย</span>
                </button>
                <button className={`nav-button ${view === 'reports' ? 'active' : ''}`} onClick={() => setView('reports')}>
                    <span className="material-symbols-outlined">bar_chart</span> <span>รายงาน</span>
                </button>
                <button className={`nav-button ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
                    <span className="material-symbols-outlined">settings</span> <span>ตั้งค่า</span>
                </button>
            </div>
            <div className="nav-right">
                <div className="date-display">{currentDate}</div>
                <div className="app-controls">
                    {(view === 'pos' || view === 'orders' || view === 'settings' || view === 'reports') && (
                         <button className={`control-btn admin-toggle ${isAdminMode ? 'active' : ''}`} onClick={isAdminMode ? handleAdminLogout : () => setShowAdminLoginModal(true)} title={isAdminMode ? 'ออกจากโหมดแก้ไข' : 'แก้ไขเมนู/บิล/ตั้งค่า'}>
                            <span className="material-symbols-outlined">{isAdminMode ? 'lock' : 'edit'}</span>
                        </button>
                    )}
                    <button className="control-btn" onClick={toggleTheme} title={theme === 'light' ? 'โหมดกลางคืน' : 'โหมดกลางวัน'}>
                        <span className="material-symbols-outlined">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
                    </button>
                    <button className="control-btn" onClick={handleZoomOut} title="ลดขนาด">
                        <span className="material-symbols-outlined">zoom_out</span>
                    </button>
                    <button className="control-btn" onClick={handleZoomIn} title="เพิ่มขนาด">
                        <span className="material-symbols-outlined">zoom_in</span>
                    </button>
                </div>
                <button className="cart-toggle-btn" onClick={() => setIsOrderPanelOpen(prev => !prev)}>
                    <span className="material-symbols-outlined">shopping_cart</span>
                    {cartItemCount > 0 && <span className="cart-badge">{cartItemCount}</span>}
                </button>
            </div>
        </nav>
    );

    const CategoryColumn = () => (
        <aside className="category-column">
            <div className="search-bar-container">
                 <span className="material-symbols-outlined search-icon">search</span>
                 <input
                    type="text"
                    placeholder="ค้นหาเมนู (เช่น แซลมอน)"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="menu-search-input"
                    onFocus={() => setFocusedItem(null)}
                 />
            </div>
            <h2>หมวดหมู่</h2>
            <ul className="category-list"
                tabIndex={shopSettings.isKeyboardNavEnabled ? 0 : -1}
                onFocus={() => {
                    if (shopSettings.isKeyboardNavEnabled && focusedItem?.pane !== 'categories') {
                        setFocusedItem({ pane: 'categories', index: navCategories.indexOf(activeCategory) ?? 0 });
                    }
                }}
            >
                {navCategories.map((cat, index) => {
                    const isFocused = shopSettings.isKeyboardNavEnabled && focusedItem?.pane === 'categories' && focusedItem.index === index;
                    return (
                        <li key={cat}
                            ref={getCategoryItemRef(cat)}
                            className={`category-list-item ${activeCategory === cat && searchQuery.trim() === '' ? 'active' : ''} ${isFocused ? 'keyboard-focused' : ''}`}
                            onClick={() => {
                                setSearchQuery('');
                                setActiveCategory(cat);
                            }}>
                            <span className={`material-symbols-outlined ${cat === 'รายการโปรด' ? 'favorite-icon' : ''}`}>{
                                { 
                                    'รายการโปรด': 'star', 'ทาโกะดั้งเดิม': 'ramen_dining', 'ทาโกะเบคอน': 'outdoor_grill', 
                                    'ทาโกะแซลมอน': 'set_meal', 'ทาโกะคอมโบ้': 'restaurant_menu', 'ท็อปปิ้งพิเศษ': 'add_circle',
                                    'เดลิเวอรี่': 'delivery_dining', 'ไอศครีม': 'icecream', 'เครื่องดื่ม': 'local_bar',
                                    'สินค้าพิเศษ': 'shopping_bag'
                                }[cat] || 'label'
                            }</span>
                            <span className="category-name">{cat}</span>
                            {isAdminMode && cat !== 'รายการโปรด' && (
                                 <button className="delete-category-btn" onClick={(e) => { e.stopPropagation(); handleDeleteCategory(cat); }}>&times;</button>
                            )}
                        </li>
                    );
                })}
                {isAdminMode && (
                    <li className="category-list-item add-category-btn" onClick={handleAddCategory}>
                        <span className="material-symbols-outlined">add_circle</span>
                        <span className="category-name">เพิ่มหมวดหมู่</span>
                    </li>
                )}
            </ul>
        </aside>
    );

    const MenuGrid = () => (
        <section className="menu-section">
            <header className="menu-header">
                <h1>{searchQuery.trim() !== '' ? `ผลการค้นหา` : activeCategory}</h1>
                 {isAdminMode && activeCategory !== 'รายการโปรด' && searchQuery.trim() === '' && !isMenuLoading && (
                    <button className="action-button add-item-btn" onClick={() => handleOpenMenuItemModal(null, activeCategory)}>
                        <span className="material-symbols-outlined">add</span> เพิ่มสินค้าใหม่
                    </button>
                )}
            </header>
            {isMenuLoading ? (
                <div className="menu-grid-message" style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'}}>
                    <span className="material-symbols-outlined sync-icon pending" style={{fontSize: '2rem'}}>sync</span>
                    <p>กำลังโหลดเมนูจาก Google Sheet...</p>
                </div>
            ) : menuError ? (
                <div className="menu-grid-message error-message" style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'}}>
                    <span className="material-symbols-outlined" style={{fontSize: '2rem', color: 'var(--danger-color)'}}>error</span>
                    <p>{menuError}</p>
                    <p>กรุณาตรวจสอบการตั้งค่า URL และลองรีเฟรชหน้าจอ</p>
                </div>
            ) : (
                <div className="menu-grid" 
                    tabIndex={shopSettings.isKeyboardNavEnabled ? 0 : -1}
                    ref={menuGridRef}
                    onFocus={() => {
                        if (shopSettings.isKeyboardNavEnabled && filteredMenuItems.length > 0 && focusedItem?.pane !== 'menu') {
                            setFocusedItem({ pane: 'menu', index: 0 });
                        }
                    }}
                >
                    {filteredMenuItems.length === 0 && searchQuery.trim() !== '' && <p className="menu-grid-message">ไม่พบสินค้าที่ตรงกับ: "{searchQuery}"</p>}
                    {filteredMenuItems.length === 0 && searchQuery.trim() === '' && activeCategory === 'รายการโปรด' && <p className="menu-grid-message">ยังไม่มีรายการโปรด... กด ⭐️ เพื่อเพิ่ม</p>}
                    {filteredMenuItems.length === 0 && searchQuery.trim() === '' && activeCategory !== 'รายการโปรด' && <p className="menu-grid-message">ไม่มีสินค้าในหมวดหมู่นี้</p>}
                    {filteredMenuItems.map((item, index) => {
                        const isFocused = shopSettings.isKeyboardNavEnabled && focusedItem?.pane === 'menu' && focusedItem.index === index;
                        return (
                            <div key={item.id} className={`menu-card ${isFocused ? 'keyboard-focused' : ''}`} ref={getMenuItemRef(item.id)}>
                                {isAdminMode && (
                                    <div className="admin-item-controls">
                                        <button onClick={() => handleDeleteItem(item.id)} title="ลบสินค้า"><span className="material-symbols-outlined">delete</span></button>
                                        <button onClick={() => handleOpenMenuItemModal(item)} title="แก้ไขสินค้า"><span className="material-symbols-outlined">edit</span></button>
                                    </div>
                                )}
                                <button className="menu-card-fav-btn" onClick={() => toggleFavorite(item.id)}>
                                    <span className={`material-symbols-outlined ${favoriteIds.has(item.id) ? 'filled' : ''}`}>star</span>
                                </button>
                                <div className="card-content" onClick={() => addToCart(item)}>
                                    <img src={item.image} alt={item.name} loading="lazy" onError={(e) => { e.currentTarget.src = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&auto=format&fit=crop'; }}/>
                                    <div className="menu-card-body">
                                        <h3 className="menu-card-title">{item.name}</h3>
                                        <p className="menu-card-price">฿{item.price.toFixed(2)}</p>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
    
    const OrderPanel = () => (
        <aside className={`order-panel ${isOrderPanelOpen ? 'is-open' : ''}`}>
            <header className="order-header">
                <h2>ออเดอร์ปัจจุบัน</h2>
                 <div className="order-header-actions">
                    {cart.length > 0 && <button className="clear-cart-btn" onClick={clearCart}>ล้างทั้งหมด</button>}
                    <button className="close-panel-btn" onClick={() => setIsOrderPanelOpen(false)}>&times;</button>
                </div>
            </header>
            <div className="cart-items-container">
                {cart.length === 0 ? (
                    <p className="cart-empty-message">คลิกที่สินค้าเพื่อเพิ่มลงในออเดอร์</p>
                ) : (
                    cart.map(item => (
                        <div key={item.id} className="cart-item">
                           <div className="cart-item-info">
                                <p className="cart-item-name">{item.name}</p>
                                <p className="cart-item-price">฿{item.price.toFixed(2)}</p>
                            </div>
                            <div className="cart-item-quantity">
                                <button className="quantity-btn" onClick={() => updateQuantity(item.id, -1)}>−</button>
                                <span className="quantity-value">{item.quantity}</span>
                                <button className="quantity-btn" onClick={() => updateQuantity(item.id, 1)}>+</button>
                            </div>
                            <div className="cart-item-total">฿{(item.price * item.quantity).toFixed(2)}</div>
                        </div>
                    ))
                )}
            </div>
            {cart.length > 0 && (
                <div className="order-summary">
                    <div className="summary-row"><span>ยอดรวม</span><span>฿{cartCalculations.subtotal.toFixed(2)}</span></div>
                    <div className="summary-row">
                        <label htmlFor="discount" className="discount-label">ส่วนลด</label>
                        <input type="text" id="discount" className="discount-input" placeholder="เช่น 50 หรือ 10%" value={discount} onChange={(e) => setDiscount(e.target.value)}/>
                    </div>
                    {cartCalculations.discountValue > 0 && <div className="summary-row"><span>ใช้ส่วนลดแล้ว</span><span>-฿{cartCalculations.discountValue.toFixed(2)}</span></div>}
                    <div className="summary-row">
                        <div className="vat-toggle">
                            <span>ภาษีมูลค่าเพิ่ม (VAT 7%)</span>
                            <label className="switch"><input type="checkbox" checked={isVatEnabled} onChange={() => setIsVatEnabled(!isVatEnabled)} /><span className="slider"></span></label>
                        </div>
                    </div>
                    {isVatEnabled && <div className="summary-row"><span>ภาษี (7%)</span><span>฿{cartCalculations.tax.toFixed(2)}</span></div>}
                    <div className="summary-row total"><span>ยอดสุทธิ</span><span>฿{cartCalculations.total.toFixed(2)}</span></div>
                    <button className="charge-btn" onClick={() => setShowPaymentModal(true)} disabled={cart.length === 0 || (currentShift === null)}>
                        {currentShift === null ? 'กรุณาเปิดกะก่อนขาย' : `ชำระเงิน ฿${cartCalculations.total.toFixed(2)}`}
                    </button>
                </div>
            )}
        </aside>
    );
    
    const PaymentModal = () => {
        const [paymentMethod, setPaymentMethod] = useState<'cash' | 'qr'>('cash');
        const [cashReceived, setCashReceived] = useState('');
        const { total } = cartCalculations;
        const change = parseFloat(cashReceived) - total;
        
        return (
            <div className="modal-overlay" onClick={() => setShowPaymentModal(false)}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <div className="modal-header"><h2 className="modal-title">การชำระเงิน</h2><button className="close-modal-btn" onClick={() => setShowPaymentModal(false)}>&times;</button></div>
                    <div className="payment-total"><p>ยอดที่ต้องชำระ</p><h3>฿{total.toFixed(2)}</h3></div>
                    <div className="payment-methods">
                        <button className={`payment-method-btn ${paymentMethod === 'cash' ? 'active' : ''}`} onClick={() => setPaymentMethod('cash')}><span className="material-symbols-outlined">payments</span> เงินสด</button>
                        <button className={`payment-method-btn ${paymentMethod === 'qr' ? 'active' : ''}`} onClick={() => setPaymentMethod('qr')}><span className="material-symbols-outlined">qr_code_2</span> QR Code</button>
                    </div>
                    {paymentMethod === 'cash' && (
                        <div className="cash-input-area">
                            <label htmlFor="cashReceived">รับเงินสด</label>
                            <input id="cashReceived" type="number" className="cash-input" value={cashReceived} onChange={e => setCashReceived(e.target.value)} placeholder="0.00" autoFocus />
                            {change >= 0 && <p className="cash-change">เงินทอน: ฿{change.toFixed(2)}</p>}
                        </div>
                    )}
                    {paymentMethod === 'qr' && (
                        <div className="qr-area" style={{textAlign: 'center'}}>
                            <p>สแกน QR code เพื่อชำระเงิน</p>
                            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=PROMPTPAY-PAYMENT-DATA-FOR-${total.toFixed(2)}`} alt="QR Code" />
                        </div>
                    )}
                    <button className="confirm-payment-btn" onClick={() => handlePlaceOrder(paymentMethod, cashReceived ? parseFloat(cashReceived) : undefined)} disabled={isPlacingOrder || (paymentMethod === 'cash' && (change < 0 || cashReceived === ''))}>
                        ยืนยันการชำระเงิน
                    </button>
                </div>
            </div>
        );
    };

    const ReceiptModal = ({ show, onClose, orderData, shopSettings, offlineLogo, offlinePromo }: { show: boolean, onClose: () => void, orderData: (Order & { cashReceived?: number }) | null, shopSettings: ShopSettings, offlineLogo: string | null, offlinePromo: string | null }) => {
        const [receiptWidth, setReceiptWidth] = useState<'58mm' | '80mm'>('58mm');
        const [autoPrint, setAutoPrint] = useState(true);
    
        const handlePrint = () => {
            // Temporarily set a class on body to activate print styles for the receipt
             document.body.classList.add(`printing-receipt-${receiptWidth}`);
            window.print();
            // Clean up the class after printing
            document.body.classList.remove(`printing-receipt-${receiptWidth}`);
        };
    
        const handleClose = () => {
            if (autoPrint) {
                handlePrint();
            }
            onClose();
        };
    
        if (!show || !orderData) return null;
    
        const change = orderData.cashReceived ? orderData.cashReceived - orderData.total : 0;
    
        return (
            <div className="modal-overlay receipt-modal-overlay" onClick={onClose}>
                <div className="receipt-modal-content" onClick={e => e.stopPropagation()}>
                    <div className="receipt-controls">
                        <h3>ตัวเลือกใบเสร็จ</h3>
                        <div className="form-group">
                            <label>ขนาดกระดาษ</label>
                            <div className="receipt-size-toggle">
                               <button className={receiptWidth === '58mm' ? 'active' : ''} onClick={() => setReceiptWidth('58mm')}>58mm</button>
                               <button className={receiptWidth === '80mm' ? 'active' : ''} onClick={() => setReceiptWidth('80mm')}>80mm</button>
                            </div>
                        </div>
                        <div className="form-group">
                            <label>พิมพ์ใบเสร็จเมื่อปิด</label>
                            <div className="vat-toggle">
                                <span>ไม่พิมพ์/พิมพ์</span>
                                <label className="switch"><input type="checkbox" checked={autoPrint} onChange={() => setAutoPrint(p => !p)} /><span className="slider"></span></label>
                            </div>
                        </div>
                        
                        <button className="action-button" onClick={handlePrint}><span className="material-symbols-outlined">print</span> พิมพ์ทันที</button>
                        <button className="action-button success-button" style={{marginTop: 'auto'}} onClick={handleClose}>
                            <span className="material-symbols-outlined">point_of_sale</span> {autoPrint ? 'พิมพ์และขายต่อ' : 'ปิดและขายต่อ'}
                        </button>
    
                    </div>
                    <div className="receipt-preview">
                        <div id="printable-receipt" className={`receipt-paper receipt-${receiptWidth}`}>
                            <div className="receipt-header-content">
                                <img
                                    src={offlineLogo || shopSettings.logoUrl}
                                    alt="Shop Logo"
                                    className="receipt-logo"
                                    style={{
                                        width: `${shopSettings.logoWidth}px`,
                                        height: `${shopSettings.logoHeight}px`,
                                        objectFit: 'contain',
                                        margin: '4px auto'
                                    }}
                                />
                                <p><strong>{shopSettings.shopName}</strong></p>
                                <p>{shopSettings.address}</p>
                                <p>ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ</p>
                            </div>
                            <div className="receipt-info">
                                <span>เลขที่: {orderData.id}</span>
                                <span>วันที่: {new Date(orderData.timestamp).toLocaleString('th-TH')}</span>
                            </div>
                            <hr className="receipt-hr" />
                            <table className="receipt-items-table">
                                <thead>
                                    <tr>
                                        <th>รายการ</th>
                                        <th className="col-qty">จำนวน</th>
                                        <th className="col-price">ราคา</th>
                                        <th className="col-total">รวม</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orderData.items.map(item => (
                                        <tr key={item.id}>
                                            <td>{item.name}</td>
                                            <td className="col-qty">{item.quantity}</td>
                                            <td className="col-price">{item.price.toFixed(2)}</td>
                                            <td className="col-total">{(item.price * item.quantity).toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <hr className="receipt-hr" />
                            <table className="receipt-summary-table">
                                <tbody>
                                    <tr><td>ยอดรวม</td><td>{orderData.subtotal.toFixed(2)}</td></tr>
                                    {orderData.discountValue > 0 && <tr><td>ส่วนลด</td><td>-{orderData.discountValue.toFixed(2)}</td></tr>}
                                    {orderData.tax > 0 && <tr><td>ภาษีมูลค่าเพิ่ม ({(orderData.vatRate * 100).toFixed(0)}%)</td><td>{orderData.tax.toFixed(2)}</td></tr>}
                                    <tr className="total"><td><strong>ยอดสุทธิ</strong></td><td><strong>{orderData.total.toFixed(2)}</strong></td></tr>
                                    {orderData.paymentMethod === 'cash' && typeof orderData.cashReceived !== 'undefined' && (
                                        <>
                                            <tr className="receipt-payment-separator"><td colSpan={2}><hr className="receipt-hr" /></td></tr>
                                            <tr><td>รับเงินสด</td><td>{orderData.cashReceived.toFixed(2)}</td></tr>
                                            <tr><td>เงินทอน</td><td>{change.toFixed(2)}</td></tr>
                                        </>
                                    )}
                                </tbody>
                            </table>
                            <hr className="receipt-hr" />
                            <div className="receipt-footer">
                                <p>{shopSettings.headerText}</p>
                                <img
                                    src={offlinePromo || shopSettings.promoUrl}
                                    alt="Promo"
                                    className="receipt-promo"
                                    style={{
                                        width: `${shopSettings.promoWidth}px`,
                                        height: `${shopSettings.promoHeight}px`,
                                        objectFit: 'contain',
                                        margin: '4px auto'
                                    }}
                                />
                                <p>{shopSettings.footerText}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };
    
    const AdminLoginModal = ({ show, onClose, onLogin }: { show: boolean, onClose: () => void, onLogin: (password: string) => boolean }) => {
        const [password, setPassword] = useState('');
        const [error, setError] = useState('');

        if (!show) return null;

        const handleSubmit = (e: React.FormEvent) => {
            e.preventDefault();
            if (onLogin(password)) {
                setPassword('');
                setError('');
            } else {
                setError('รหัสผ่านไม่ถูกต้อง');
            }
        };

        return (
             <div className="modal-overlay" onClick={onClose}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <form onSubmit={handleSubmit}>
                        <div className="modal-header">
                            <h2 className="modal-title">สำหรับผู้ดูแล</h2>
                            <button type="button" className="close-modal-btn" onClick={onClose}>&times;</button>
                        </div>
                        <div className="form-group">
                            <label htmlFor="adminUser">ชื่อผู้ใช้</label>
                            <input type="text" id="adminUser" value="admin" readOnly disabled />
                        </div>
                         <div className="form-group">
                            <label htmlFor="adminPass">รหัสผ่าน</label>
                            <input type="password" id="adminPass" value={password} onChange={e => setPassword(e.target.value)} autoFocus required />
                        </div>
                        {error && <p className="error-message">{error}</p>}
                        <button type="submit" className="action-button" style={{width: '100%', justifyContent: 'center'}}>เข้าสู่ระบบ</button>
                    </form>
                </div>
            </div>
        )
    };
    
    const MenuItemModal = ({ show, onClose, onSave, item, categories }: { show: boolean, onClose: () => void, onSave: (item: MenuItem) => void, item: MenuItem | { category: string } | null, categories: string[] }) => {
        const [formData, setFormData] = useState<Omit<MenuItem, 'id'>>({ name: '', price: 0, image: '', category: '' });

        useEffect(() => {
            if (item && 'name' in item) { // Editing existing item
                setFormData({ name: item.name, price: item.price, image: item.image, category: item.category });
            } else if (item) { // Adding new item, pre-fill category
                setFormData({ name: '', price: 0, image: '', category: item.category });
            }
        }, [item]);

        if (!show) return null;
        
        const isNew = !item || !('id' in item);

        const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
            const { name, value } = e.target;
            setFormData(prev => ({ ...prev, [name]: name === 'price' ? parseFloat(value) || 0 : value }));
        };

        const handleSubmit = (e: React.FormEvent) => {
            e.preventDefault();
            if (!formData.name || !formData.category) {
                alert('กรุณากรอกชื่อและเลือกหมวดหมู่');
                return;
            }
            onSave({ ...formData, id: isNew ? 0 : (item as MenuItem).id });
        };
        
        return (
            <div className="modal-overlay" onClick={onClose}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <form onSubmit={handleSubmit}>
                        <div className="modal-header">
                            <h2 className="modal-title">{isNew ? 'เพิ่มสินค้าใหม่' : 'แก้ไขสินค้า'}</h2>
                            <button type="button" className="close-modal-btn" onClick={onClose}>&times;</button>
                        </div>
                        <div className="form-group"><label htmlFor="name">ชื่อสินค้า</label><input type="text" id="name" name="name" value={formData.name} onChange={handleChange} required /></div>
                        <div className="form-group"><label htmlFor="price">ราคา</label><input type="number" id="price" name="price" value={formData.price} onChange={handleChange} required /></div>
                        <div className="form-group"><label htmlFor="image">URL รูปภาพ</label><input type="text" id="image" name="image" value={formData.image} onChange={handleChange} /></div>
                        <div className="form-group"><label htmlFor="category">หมวดหมู่</label>
                            <select id="category" name="category" value={formData.category} onChange={handleChange} required>
                                <option value="" disabled>-- เลือกหมวดหมู่ --</option>
                                {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                            </select>
                        </div>
                        <button type="submit" className="action-button" style={{width: '100%', justifyContent: 'center'}}>{isNew ? 'เพิ่มสินค้า' : 'บันทึกการเปลี่ยนแปลง'}</button>
                    </form>
                </div>
            </div>
        );
    };

    const BillDetails = ({ order }: { order: Order }) => (
        <td colSpan={7} className="receipt-details-cell">
            <div className="receipt-details-content">
                <ul className="receipt-item-list">
                    {order.items.map(item => (
                        <li key={item.id}>
                            <span>{item.quantity} x {item.name}</span>
                            <span>฿{(item.quantity * item.price).toFixed(2)}</span>
                        </li>
                    ))}
                </ul>
                <div className="receipt-summary">
                    <div><span>ยอดรวม</span> <span>฿{order.subtotal.toFixed(2)}</span></div>
                    {order.discountValue > 0 && <div><span>ส่วนลด</span> <span>-฿{order.discountValue.toFixed(2)}</span></div>}
                    {order.tax > 0 && <div><span>ภาษี ({(order.vatRate * 100).toFixed(0)}%)</span> <span>฿{order.tax.toFixed(2)}</span></div>}
                    <div className="receipt-total"><span>ยอดสุทธิ</span> <span>฿{order.total.toFixed(2)}</span></div>
                </div>
            </div>
        </td>
    );

    const OrderManagementScreen = ({ kitchenOrders, completedOrders, onUpdateStatus, onCompleteOrder, isAdminMode, onCancelBill }: { kitchenOrders: KitchenOrder[], completedOrders: Order[], onUpdateStatus: (id: string, status: 'cooking' | 'ready') => void, onCompleteOrder: (id: string) => void, isAdminMode: boolean, onCancelBill: (order: Order) => void }) => {
        const [expandedId, setExpandedId] = useState<string | null>(null);
        const [activeKdsTab, setActiveKdsTab] = useState<'bills' | 'shift'>('bills');

        const activeOrders = kitchenOrders.sort((a, b) => a.id.localeCompare(b.id)); 
        const activeOrderIds = new Set(kitchenOrders.map(o => o.id));

        const recentlyCompleted = completedOrders
            .filter(o => !activeOrderIds.has(o.id))
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 50);

        const todaysTotalSales = useMemo(() => {
            const todayStr = getYYYYMMDD(new Date());
            return completedOrders
                .filter(order => getYYYYMMDD(new Date(order.timestamp)) === todayStr && order.status !== 'cancelled')
                .reduce((sum, order) => sum + order.total, 0);
        }, [completedOrders]);

        const TimeAgo = ({ date }: { date: Date }) => {
            const [time, setTime] = useState('');
            useEffect(() => {
                const update = () => {
                    const seconds = Math.floor((new Date().getTime() - new Date(date).getTime()) / 1000);
                    if (seconds < 0) {
                        setTime('0s');
                        return;
                    }
                    const minutes = Math.floor(seconds / 60);
                    const hours = Math.floor(minutes / 60);
                    if (hours > 23) setTime(`${Math.floor(hours/24)}d ago`);
                    else if (hours > 0) setTime(`${hours}h ${minutes % 60}m ago`);
                    else if (minutes > 0) setTime(`${minutes}m ${seconds % 60}s ago`);
                    else setTime(`${seconds}s ago`);
                };
                update();
                const interval = setInterval(update, 5000);
                return () => clearInterval(interval);
            }, [date]);
            return <span className="time-ago">{time}</span>;
        };

        return (
            <div className="order-management-screen">
                <section className="active-orders-section">
                    <header className="kds-header">
                        <h1><span className="material-symbols-outlined">skillet</span> กำลังดำเนินการ ({activeOrders.length})</h1>
                    </header>
                    {activeOrders.length === 0 ? (
                        <p className="kds-empty-message">ไม่มีออเดอร์ที่กำลังดำเนินการ</p>
                    ) : (
                        <div className="kitchen-order-grid">
                            {activeOrders.map(order => (
                                <div key={order.id} className={`order-card status-${order.status}`}>
                                    <div className="order-card-header">
                                        <div className="order-card-title">
                                            <h3>{order.id}</h3>
                                            <span className={`status-badge status-${order.status}`}>
                                                {order.status === 'cooking' ? 'กำลังทำ' : 'พร้อมส่ง'}
                                            </span>
                                        </div>
                                        <TimeAgo date={order.timestamp} />
                                    </div>
                                    <ul className="order-card-items">
                                        {order.items.map(item => (
                                            <li key={`${order.id}-${item.id}`}>
                                                <span className="item-quantity">{item.quantity}x</span>
                                                <span className="item-name">{item.name}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <div className="order-card-footer">
                                        {order.status === 'cooking' ? (
                                            <button className="kds-action-btn ready-btn" onClick={() => onUpdateStatus(order.id, 'ready')}>
                                                <span className="material-symbols-outlined">check_circle</span> ทำเสร็จแล้ว
                                            </button>
                                        ) : (
                                            <button className="kds-action-btn complete-btn" onClick={() => onCompleteOrder(order.id)}>
                                                <span className="material-symbols-outlined">takeout_dining</span> ปิดบิล (รับแล้ว)
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
                <section className="completed-bills-section">
                     <header className="kds-header kds-tab-header">
                        <div className="kds-tabs">
                             <button className={`kds-tab-btn ${activeKdsTab === 'bills' ? 'active' : ''}`} onClick={() => setActiveKdsTab('bills')}>
                                <span className="material-symbols-outlined">history</span> บิลที่เสร็จสิ้นล่าสุด
                            </button>
                            <button className={`kds-tab-btn ${activeKdsTab === 'shift' ? 'active' : ''}`} onClick={() => setActiveKdsTab('shift')}>
                                <span className="material-symbols-outlined">savings</span> จัดการกะและเงินสด
                            </button>
                        </div>
                    </header>
                    {activeKdsTab === 'bills' && (
                        <div className="completed-bills-list-container">
                            <div className="completed-bills-list">
                                <table className="report-table kds-completed-table">
                                    <thead><tr><th>เลขที่บิล</th><th>เวลา</th><th>ยอดขาย</th><th>การชำระเงิน</th><th>สถานะ</th><th title="สถานะการซิงค์"><span className="material-symbols-outlined">cloud_sync</span></th><th></th></tr></thead>
                                    <tbody>
                                        {recentlyCompleted.map(order => (
                                            <Fragment key={order.id}>
                                            <tr className={`expandable-row ${order.status === 'cancelled' ? 'cancelled-bill' : ''} ${order.total < 0 ? 'reversal-bill' : ''}`} onClick={() => order.status !== 'cancelled' && setExpandedId(prev => prev === order.id ? null : order.id)}>
                                                <td>{order.id} <span className={`chevron ${expandedId === order.id ? 'expanded' : ''}`}></span></td>
                                                <td>{new Date(order.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</td>
                                                <td>฿{order.total.toFixed(2)}</td>
                                                <td>{order.paymentMethod === 'cash' ? 'เงินสด' : 'QR Code'}</td>
                                                <td>
                                                    <span className={`status-tag status-${order.status}`}>
                                                        {order.status === 'completed' ? (order.reversalOf ? 'คืนเงิน' : 'สำเร็จ') : 'ยกเลิก'}
                                                    </span>
                                                </td>
                                                <td>
                                                    {order.syncStatus === 'synced' && <span className="material-symbols-outlined sync-icon synced" title="ซิงค์ข้อมูลแล้ว">cloud_done</span>}
                                                    {order.syncStatus === 'pending' && <span className="material-symbols-outlined sync-icon pending" title="รอซิงค์ข้อมูล">cloud_upload</span>}
                                                    {order.syncStatus === 'failed' && <span className="material-symbols-outlined sync-icon failed" title="การซิงค์ล้มเหลว">cloud_off</span>}
                                                </td>
                                                <td>
                                                    {isAdminMode && order.status !== 'cancelled' && (
                                                        <button className="delete-bill-btn" title="ยกเลิกบิล" onClick={(e) => { e.stopPropagation(); onCancelBill(order); }}>
                                                            <span className="material-symbols-outlined">delete</span>
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                            {expandedId === order.id && <tr><BillDetails order={order} /></tr>}
                                            </Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <footer className="kds-summary-footer">
                                <span>ยอดขายรวมวันนี้</span>
                                <span className="footer-total">฿{todaysTotalSales.toFixed(2)}</span>
                            </footer>
                        </div>
                    )}
                     {activeKdsTab === 'shift' && <ShiftManagementPanel />}
                </section>
            </div>
        );
    };
    
    // --- Shift Management Components ---
    const ShiftManagementPanel = () => {
        if (!currentShift) {
            return (
                <div className="shift-management-panel">
                    <div className="shift-start-screen">
                        <span className="material-symbols-outlined">storefront</span>
                        <p>ยังไม่มีการเปิดกะการขายสำหรับวันนี้</p>
                        <button className="action-button" onClick={() => setShowStartShiftModal(true)}>
                            <span className="material-symbols-outlined">play_circle</span> เปิดกะใหม่
                        </button>
                    </div>
                </div>
            )
        }

        return (
            <div className="shift-management-panel">
                <div className="shift-dashboard">
                    <div className="shift-header">
                        <div className="shift-header-info">
                            กะปัจจุบัน: <strong>{currentShift.id}</strong> | เริ่มเมื่อ: <strong>{new Date(currentShift.startTime).toLocaleTimeString('th-TH')}</strong>
                        </div>
                        <div className="shift-actions">
                            <button className="action-button" onClick={() => setShowPaidInOutModal(true)}>
                               <span className="material-symbols-outlined">swap_horiz</span> นำเงินเข้า/ออก
                            </button>
                            <button className="action-button danger-button" onClick={() => setShowEndShiftModal(true)}>
                               <span className="material-symbols-outlined">stop_circle</span> ปิดกะการขาย
                            </button>
                        </div>
                    </div>
                    <div className="shift-summary-cards">
                        <div className="shift-summary-card">
                            <div className="shift-summary-card-title"><span className="material-symbols-outlined">attach_money</span>เงินเริ่มต้น</div>
                            <div className="shift-summary-card-value">฿{currentShift.openingFloatAmount.toFixed(2)}</div>
                        </div>
                         <div className="shift-summary-card">
                            <div className="shift-summary-card-title"><span className="material-symbols-outlined">point_of_sale</span>ยอดขาย (เงินสด)</div>
                            <div className="shift-summary-card-value">฿{shiftSummaryData?.totalCashSales.toFixed(2)}</div>
                        </div>
                        <div className="shift-summary-card">
                            <div className="shift-summary-card-title"><span className="material-symbols-outlined">qr_code</span>ยอดขาย (QR)</div>
                            <div className="shift-summary-card-value">฿{shiftSummaryData?.totalQrSales.toFixed(2)}</div>
                        </div>
                         <div className="shift-summary-card">
                            <div className="shift-summary-card-title"><span className="material-symbols-outlined">account_balance_wallet</span>เงินสดในลิ้นชัก (คาดการณ์)</div>
                            <div className="shift-summary-card-value">฿{shiftSummaryData?.expectedCashInDrawer.toFixed(2)}</div>
                        </div>
                    </div>
                    <div className="activity-log-container">
                        <h3 className="activity-log-header">รายการเคลื่อนไหวในลิ้นชัก</h3>
                        <table className="activity-log-table">
                            <thead>
                                <tr>
                                    <th>เวลา</th>
                                    <th>ประเภท</th>
                                    <th>หมายเหตุ</th>
                                    <th className="amount-col">จำนวนเงิน</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...currentShift.activities].reverse().map(act => (
                                    <tr key={act.id}>
                                        <td>{new Date(act.timestamp).toLocaleTimeString('th-TH')}</td>
                                        <td>{act.type}</td>
                                        <td>{act.description}</td>
                                        <td className={`amount-col ${['SALE', 'PAID_IN', 'SHIFT_START'].includes(act.type) ? 'positive' : 'negative'}`}>
                                            {['SALE', 'PAID_IN', 'SHIFT_START', 'SHIFT_END'].includes(act.type) ? '+' : '-'}{act.amount.toFixed(2)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        )
    };
    
    const StartShiftModal = () => {
        const [amount, setAmount] = useState('');
        return (
            <div className="modal-overlay" onClick={() => setShowStartShiftModal(false)}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <div className="modal-header"><h2 className="modal-title">เปิดกะการขาย</h2><button type="button" className="close-modal-btn" onClick={() => setShowStartShiftModal(false)}>&times;</button></div>
                    <form onSubmit={(e) => { e.preventDefault(); handleStartShift(parseFloat(amount) || 0); }}>
                        <div className="form-group">
                            <label htmlFor="openingFloat">ยอดเงินสดเริ่มต้น (เงินทอน)</label>
                            <input type="number" id="openingFloat" value={amount} onChange={e => setAmount(e.target.value)} autoFocus required min="0" step="any" className="cash-input" />
                        </div>
                        <div className="modal-footer">
                           <button type="submit" className="action-button" disabled={!amount}>ยืนยันและเปิดกะ</button>
                        </div>
                    </form>
                </div>
            </div>
        )
    };
    
    const PaidInOutModal = () => {
        const [type, setType] = useState<'PAID_IN' | 'PAID_OUT'>('PAID_OUT');
        const [amount, setAmount] = useState('');
        const [description, setDescription] = useState('');

        const handleSubmit = (e: React.FormEvent) => {
            e.preventDefault();
            handlePaidInOut({ type, amount: parseFloat(amount), description });
        };

        return (
            <div className="modal-overlay" onClick={() => setShowPaidInOutModal(false)}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                    <div className="modal-header"><h2 className="modal-title">นำเงินเข้า/ออก</h2><button type="button" className="close-modal-btn" onClick={() => setShowPaidInOutModal(false)}>&times;</button></div>
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>ประเภทรายการ</label>
                            <div className="payment-methods">
                                <button type="button" className={`payment-method-btn ${type === 'PAID_IN' ? 'active' : ''}`} onClick={() => setType('PAID_IN')}><span className="material-symbols-outlined">add_card</span> นำเงินเข้า</button>
                                <button type="button" className={`payment-method-btn ${type === 'PAID_OUT' ? 'active' : ''}`} onClick={() => setType('PAID_OUT')}><span className="material-symbols-outlined">payments</span> นำเงินออก</button>
                            </div>
                        </div>
                         <div className="form-group">
                            <label htmlFor="p_amount">จำนวนเงิน</label>
                            <input type="number" id="p_amount" value={amount} onChange={e => setAmount(e.target.value)} required min="0" step="any" className="cash-input" />
                        </div>
                         <div className="form-group">
                            <label htmlFor="p_desc">หมายเหตุ (เช่น ซื้อน้ำแข็ง)</label>
                            <input type="text" id="p_desc" value={description} onChange={e => setDescription(e.target.value)} required />
                        </div>
                         <div className="modal-footer">
                           <button type="submit" className="action-button" disabled={!amount || !description}>บันทึกรายการ</button>
                        </div>
                    </form>
                </div>
            </div>
        )
    };

    const EndShiftModal = ({ summary, onClose, onConfirm }: { summary: any, onClose: () => void, onConfirm: (data: { counted: number, nextShift: number }) => void }) => {
        const [counted, setCounted] = useState<string>('');
        const [nextShift, setNextShift] = useState<string>('');
        
        // When the component unmounts (because showEndShiftModal becomes false),
        // state is destroyed. When it re-mounts, state is re-initialized to ''.
        // So an explicit useEffect reset is not needed.

        if (!summary) return null;
        
        const countedNum = parseFloat(counted) || 0;
        const overShort = countedNum - summary.expectedCashInDrawer;

        const handleConfirmClick = () => {
            if (window.confirm('คุณแน่ใจหรือไม่ว่าต้องการปิดกะ?')) {
                onConfirm({ counted: countedNum, nextShift: parseFloat(nextShift) || 0 });
            }
        };

        return (
             <div className="modal-overlay" onClick={onClose}>
                <div className="modal-content" onClick={e => e.stopPropagation()}>
                     <div className="modal-header"><h2 className="modal-title">ปิดกะและสรุปยอด</h2><button type="button" className="close-modal-btn" onClick={onClose}>&times;</button></div>
                     <div className="modal-content-body">
                        <h3>สรุปยอดจากระบบ</h3>
                        <div className="end-shift-summary-grid">
                           <div className="end-shift-summary-item"><span>เงินเริ่มต้น</span><span>฿{currentShift?.openingFloatAmount.toFixed(2)}</span></div>
                           <div className="end-shift-summary-item"><span>ยอดขายเงินสด</span><span>฿{summary.totalCashSales.toFixed(2)}</span></div>
                           <div className="end-shift-summary-item"><span>นำเงินเข้า</span><span>฿{summary.totalPaidIn.toFixed(2)}</span></div>
                           <div className="end-shift-summary-item"><span>นำเงินออก/คืนเงิน</span><span>-฿{summary.totalPaidOut.toFixed(2)}</span></div>
                        </div>
                        <div className="end-shift-summary-item total" style={{borderTop: '2px solid var(--primary-color)', paddingTop: '0.5rem'}}><span>เงินสดที่ควรมีในลิ้นชัก</span><span>฿{summary.expectedCashInDrawer.toFixed(2)}</span></div>
                        
                        <div style={{borderTop: '1px solid var(--border-color)', margin: '1.5rem 0'}}></div>

                        <h3>การนับและจัดการเงินสด</h3>
                        <div className="form-group">
                            <label htmlFor="countedCash">ยอดเงินสดที่นับได้จริง</label>
                            <input type="number" id="countedCash" value={counted} onChange={e => setCounted(e.target.value)} required min="0" step="any" className="cash-input" autoFocus/>
                        </div>
                         {counted && (
                            <div className="end-shift-summary-item">
                                <span>เงินขาด/เกิน</span>
                                <span className={`over-short-value ${overShort > 0 ? 'over' : overShort < 0 ? 'short' : 'even'}`}>
                                    ฿{overShort.toFixed(2)}
                                </span>
                            </div>
                         )}

                         <div className="form-group">
                            <label htmlFor="nextShiftCash">เก็บเงินสดไว้สำหรับกะถัดไป</label>
                            <input type="number" id="nextShiftCash" value={nextShift} onChange={e => setNextShift(e.target.value)} required min="0" step="any" className="cash-input"/>
                        </div>
                        {counted && nextShift && (
                             <div className="end-shift-summary-item total"><span>ยอดเงินสดที่ต้องนำส่ง</span><span>฿{(countedNum - (parseFloat(nextShift) || 0)).toFixed(2)}</span></div>
                        )}
                     </div>

                     <div className="modal-footer">
                        <button type="button" className="action-button danger-button" onClick={handleConfirmClick} disabled={!counted.trim() || !nextShift.trim()}>ยืนยันและปิดกะ</button>
                     </div>
                </div>
            </div>
        )
    };


    const ReportsScreen = () => {
        type ReportTab = 'summary' | 'byProduct' | 'byCategory' | 'byPayment' | 'receipts' | 'discounts' | 'activityLog' | 'cancelledBills';
        const [activeTab, setActiveTab] = useState<ReportTab>('summary');
        
        const tabs: {id: ReportTab, name: string, icon: string}[] = [
          {id: 'summary', name: 'สรุปยอดขาย', icon: 'summarize'},
          {id: 'byProduct', name: 'ยอดขายตามสินค้า', icon: 'inventory_2'},
          {id: 'byCategory', name: 'ยอดขายตามหมวดหมู่', icon: 'category'},
          {id: 'byPayment', name: 'ยอดขายตามการชำระเงิน', icon: 'payment'},
          {id: 'receipts', name: 'บิลย้อนหลัง', icon: 'receipt_long'},
          {id: 'discounts', name: 'รายงานส่วนลด', icon: 'percent'},
          {id: 'cancelledBills', name: 'รายงานการลบบิล', icon: 'delete_forever'},
          {id: 'activityLog', name: 'ประวัติการแก้ไข', icon: 'history_toggle_off'}
        ];

        return (
            <div className="settings-screen">
                <nav className="settings-nav">
                    <h2>รายงาน</h2>
                    <ul className="settings-nav-list">
                        {tabs.map(tab => (
                             <li key={tab.id} className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
                                <span className="material-symbols-outlined">{tab.icon}</span>
                                <span>{tab.name}</span>
                            </li>
                        ))}
                    </ul>
                </nav>
                <main className="settings-content">
                    {activeTab === 'summary' && <SummaryReport orders={completedOrders} />}
                    {activeTab === 'receipts' && <ReceiptsHistory orders={completedOrders} BillDetailsComponent={BillDetails} onCancelBill={handleCancelBill} isAdminMode={isAdminMode} />}
                    {activeTab === 'byProduct' && <SalesByProductReport orders={completedOrders} />}
                    {activeTab === 'byCategory' && <SalesByCategoryReport orders={completedOrders} />}
                    {activeTab === 'byPayment' && <SalesByPaymentReport orders={completedOrders} />}
                    {activeTab === 'discounts' && <DiscountReport orders={completedOrders} />}
                    {activeTab === 'cancelledBills' && <CancelledBillsReport orders={completedOrders} />}
                    {activeTab === 'activityLog' && <ActivityLogReport log={activityLog} />}
                </main>
            </div>
        )
    }

    const formatDate = (date: Date) => date.toISOString().split('T')[0];
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);

    // Report Components
    const SummaryReport = ({ orders }: { orders: Order[] }) => {
        const [dateRange, setDateRange] = useState({ start: formatDate(weekAgo), end: formatDate(today) });
        const [preset, setPreset] = useState('7days');
        const [aiAnalysis, setAiAnalysis] = useState('');
        const [isAnalyzing, setIsAnalyzing] = useState(false);

        const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
            const value = e.target.value;
            setPreset(value);
            const end = new Date();
            let start = new Date();
            if (value === 'today') start.setHours(0,0,0,0);
            else if (value === '7days') start.setDate(end.getDate() - 7);
            else if (value === '30days') start.setDate(end.getDate() - 30);
            setDateRange({ start: formatDate(start), end: formatDate(end) });
        };

        const filteredOrders = useMemo(() => {
            const start = new Date(dateRange.start);
            start.setHours(0, 0, 0, 0);
            const end = new Date(dateRange.end);
            end.setHours(23, 59, 59, 999);
            // Include completed orders and reversals, exclude original cancelled bills
            return orders.filter(o => {
                const orderDate = new Date(o.timestamp);
                return orderDate >= start && orderDate <= end && o.status !== 'cancelled';
            });
        }, [orders, dateRange]);
        
        const reportData = useMemo(() => {
            let grossSales = 0, totalDiscount = 0, netSales = 0, totalTax = 0;
            let cashSales = 0, qrSales = 0, orderCount = 0;
            const hourlySales = Array(24).fill(0);

            for (const order of filteredOrders) {
                orderCount++;
                grossSales += order.subtotal;
                totalDiscount += order.discountValue;
                netSales += order.total;
                totalTax += order.tax;
                if (order.paymentMethod === 'cash') cashSales += order.total;
                else qrSales += order.total;

                if (preset === 'today') {
                   const hour = new Date(order.timestamp).getHours();
                   hourlySales[hour] += order.total;
                }
            }
            return { grossSales, totalDiscount, netSales, totalTax, cashSales, qrSales, orderCount, hourlySales };
        }, [filteredOrders, preset]);

        const exportToCSV = () => {
            const headers = ['id', 'timestamp', 'status', 'subtotal', 'discountValue', 'tax', 'total', 'paymentMethod'];
            const csvRows = [headers.join(',')];
            for (const order of filteredOrders) {
                const values = headers.map(header => {
                    const val = order[header as keyof Order];
                    return typeof val === 'string' ? `"${val}"` : val;
                });
                csvRows.push(values.join(','));
            }
            
            const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.setAttribute('hidden', '');
            a.setAttribute('href', url);
            a.setAttribute('download', `sales_summary_${dateRange.start}_to_${dateRange.end}.csv`);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        };
        
        const analyzeSalesWithAI = useCallback(async () => {
            setIsAnalyzing(true);
            setAiAnalysis('');
            const prompt = `
                Analyze the following sales data for a Takoyaki shop and provide 3 actionable suggestions to improve sales or operations (respond in Thai):
                - Time Period: ${dateRange.start} to ${dateRange.end}
                - Gross Sales (before discount): ${reportData.grossSales.toFixed(2)} THB
                - Total Discounts: ${reportData.totalDiscount.toFixed(2)} THB
                - Net Sales: ${reportData.netSales.toFixed(2)} THB
                - Total Bills: ${reportData.orderCount}
                - Cash Sales: ${reportData.cashSales.toFixed(2)} THB
                - QR Code Sales: ${reportData.qrSales.toFixed(2)} THB
            `;
            try {
                const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
                setAiAnalysis(response.text);
            } catch (error) {
                console.error("AI Analysis Error:", error);
                setAiAnalysis("ขออภัย, เกิดข้อผิดพลาดในการวิเคราะห์ข้อมูล");
            } finally {
                setIsAnalyzing(false);
            }
        }, [reportData, dateRange]);


        const chartOptions = { responsive: true, plugins: { legend: { position: 'top' as const } } };

        return (
            <div>
                <div className="report-header">
                    <h1>สรุปยอดขาย</h1>
                    <div className="report-controls">
                        <select value={preset} onChange={handlePresetChange}>
                            <option value="today">วันนี้</option>
                            <option value="7days">7 วันล่าสุด</option>
                            <option value="30days">30 วันล่าสุด</option>
                        </select>
                        <div className="control-group"><label>เริ่มต้น</label><input type="date" value={dateRange.start} onChange={e => setDateRange(p => ({...p, start: e.target.value}))} /></div>
                        <div className="control-group"><label>สิ้นสุด</label><input type="date" value={dateRange.end} onChange={e => setDateRange(p => ({...p, end: e.target.value}))} /></div>
                         <button className="action-button" onClick={exportToCSV}><span className="material-symbols-outlined">download</span>ส่งออก CSV</button>
                    </div>
                </div>

                <div className="summary-cards">
                    <div className="summary-card"><div className="summary-card-title">ยอดขายสุทธิ</div><div className="summary-card-value">฿{reportData.netSales.toFixed(2)}</div></div>
                    <div className="summary-card"><div className="summary-card-title">จำนวนบิล</div><div className="summary-card-value">{reportData.orderCount}</div></div>
                    <div className="summary-card"><div className="summary-card-title">ส่วนลด</div><div className="summary-card-value">฿{reportData.totalDiscount.toFixed(2)}</div></div>
                    <div className="summary-card"><div className="summary-card-title">ภาษี</div><div className="summary-card-value">฿{reportData.totalTax.toFixed(2)}</div></div>
                </div>
                 
                {preset === 'today' && reportData.orderCount > 0 && <div className="chart-container"><h3>ยอดขายรายชั่วโมง</h3><Bar options={chartOptions} data={{labels: Array.from({length: 24}, (_, i) => `${i}:00`), datasets: [{label: 'ยอดขาย (บาท)', data: reportData.hourlySales, backgroundColor: 'rgba(79, 70, 229, 0.8)'}]}} /></div>}
                
                 <div className="chart-container">
                    <h3>รูปแบบการชำระเงิน</h3>
                    {reportData.orderCount > 0 ? (
                        <Pie options={chartOptions} data={{labels: ['เงินสด', 'QR Code'], datasets: [{ label: 'ยอดขาย', data: [reportData.cashSales, reportData.qrSales], backgroundColor: ['#34d399', '#60a5fa'] }]}} />
                    ) : <p>ไม่มีข้อมูล</p>}
                </div>
                
                <div className="ai-analysis-section">
                   <div className="ai-analysis-header"><span className="material-symbols-outlined">psychology</span>AI วิเคราะห์ยอดขาย</div>
                   <button className="action-button" style={{marginTop: '1rem'}} onClick={analyzeSalesWithAI} disabled={isAnalyzing || filteredOrders.length === 0}>{isAnalyzing ? 'กำลังวิเคราะห์...' : 'เริ่มการวิเคราะห์'}</button>
                   {aiAnalysis && <div className="ai-analysis-content">{aiAnalysis}</div>}
                </div>

            </div>
        )
    };

    const ReceiptsHistory = ({ orders, BillDetailsComponent, onCancelBill, isAdminMode }: { orders: Order[], BillDetailsComponent: React.FC<{ order: Order }>, onCancelBill: (order: Order) => void, isAdminMode: boolean }) => {
        const [expandedId, setExpandedId] = useState<string | null>(null);

        return (
            <div>
                <div className="report-header"><h1>บิลย้อนหลัง</h1></div>
                <table className="report-table">
                    <thead><tr><th>เลขที่บิล</th><th>เวลา</th><th>การชำระเงิน</th><th>จำนวนรายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th></tr></thead>
                    <tbody>
                        {orders.map(order => (
                            <Fragment key={order.id}>
                                <tr className={`expandable-row ${order.status === 'cancelled' ? 'cancelled-bill' : ''} ${order.total < 0 ? 'reversal-bill' : ''}`} onClick={() => order.status !== 'cancelled' && setExpandedId(prev => prev === order.id ? null : order.id)}>
                                    <td>{order.id} <span className={`chevron ${expandedId === order.id ? 'expanded' : ''}`}></span></td>
                                    <td>{new Date(order.timestamp).toLocaleString('th-TH')}</td>
                                    <td>{order.paymentMethod === 'cash' ? 'เงินสด' : 'QR Code'}</td>
                                    <td>{order.items.reduce((sum, i) => sum + i.quantity, 0)}</td>
                                    <td>฿{order.total.toFixed(2)}</td>
                                    <td>
                                       <span className={`status-tag status-${order.status}`}>
                                           {order.status === 'completed' ? (order.reversalOf ? 'คืนเงิน' : 'สำเร็จ') : 'ยกเลิก'}
                                       </span>
                                    </td>
                                    <td>
                                        {isAdminMode && order.status === 'completed' && order.total > 0 && (
                                            <button className="delete-bill-btn" title="ยกเลิกบิล" onClick={(e) => { e.stopPropagation(); onCancelBill(order); }}>
                                                <span className="material-symbols-outlined">delete</span>
                                            </button>
                                        )}
                                    </td>
                                </tr>
                                {expandedId === order.id && <tr><BillDetailsComponent order={order} /></tr>}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    };
    
    const SalesByProductReport = ({ orders }: { orders: Order[] }) => {
        const productSales = useMemo(() => {
            const validOrders = orders.filter(o => o.status !== 'cancelled');
            const sales: { [key: string]: { name: string, quantity: number, total: number } } = {};
            validOrders.forEach(order => {
                order.items.forEach(item => {
                    if (!sales[item.id]) sales[item.id] = { name: item.name, quantity: 0, total: 0 };
                    sales[item.id].quantity += item.quantity * Math.sign(order.total); // Adjust quantity for reversals
                    sales[item.id].total += (item.price * item.quantity) * Math.sign(order.total); // Adjust total for reversals
                });
            });
            return Object.values(sales).sort((a, b) => b.quantity - a.quantity);
        }, [orders]);

        return (
            <div>
                <div className="report-header"><h1>ยอดขายตามสินค้า (ขายดีที่สุด)</h1></div>
                <table className="report-table">
                    <thead><tr><th>อันดับ</th><th>ชื่อสินค้า</th><th>จำนวนที่ขายได้ (สุทธิ)</th><th>ยอดขายรวม (สุทธิ)</th></tr></thead>
                    <tbody>
                        {productSales.map((product, index) => (
                            <tr key={product.name}>
                                <td>{index + 1}</td>
                                <td>{product.name}</td>
                                <td>{product.quantity}</td>
                                <td>฿{product.total.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    const SalesByCategoryReport = ({ orders }: { orders: Order[] }) => {
        const categorySales = useMemo(() => {
            const validOrders = orders.filter(o => o.status !== 'cancelled');
            const sales: { [key: string]: { name: string, quantity: number, total: number } } = {};
            validOrders.forEach(order => {
                order.items.forEach(item => {
                    if (!sales[item.category]) sales[item.category] = { name: item.category, quantity: 0, total: 0 };
                    sales[item.category].quantity += item.quantity * Math.sign(order.total);
                    sales[item.category].total += (item.price * item.quantity) * Math.sign(order.total);
                });
            });
            return Object.values(sales).sort((a, b) => b.total - a.total);
        }, [orders]);

         return (
            <div>
                <div className="report-header"><h1>ยอดขายตามหมวดหมู่</h1></div>
                <div className="chart-container">
                    {categorySales.length > 0 ? (
                        <Bar options={{ responsive: true, plugins: { legend: { display: false } } }} data={{
                            labels: categorySales.map(c => c.name),
                            datasets: [{ label: 'ยอดขาย (บาท)', data: categorySales.map(c => c.total), backgroundColor: '#818cf8' }]
                        }}/>
                    ) : <p>ไม่มีข้อมูล</p>}
                </div>
            </div>
        );
    };
    
    const SalesByPaymentReport = ({ orders }: { orders: Order[] }) => {
        const paymentSales = useMemo(() => {
            const validOrders = orders.filter(o => o.status !== 'cancelled');
            const sales = { cash: { total: 0, count: 0}, qr: { total: 0, count: 0 } };
            validOrders.forEach(order => {
                if(order.paymentMethod === 'cash') {
                    sales.cash.total += order.total;
                    sales.cash.count++;
                } else {
                    sales.qr.total += order.total;
                    sales.qr.count++;
                }
            });
            return sales;
        }, [orders]);
        
        return (
             <div>
                <div className="report-header"><h1>ยอดขายตามประเภทการชำระเงิน</h1></div>
                <div className="summary-cards">
                    <div className="summary-card"><div className="summary-card-title">เงินสด</div><div className="summary-card-value">฿{paymentSales.cash.total.toFixed(2)}</div><p>{paymentSales.cash.count} บิล</p></div>
                    <div className="summary-card"><div className="summary-card-title">QR Code</div><div className="summary-card-value">฿{paymentSales.qr.total.toFixed(2)}</div><p>{paymentSales.qr.count} บิล</p></div>
                </div>
                <div className="chart-container">
                   {(paymentSales.cash.count > 0 || paymentSales.qr.count > 0) ? (
                     <Pie options={{ responsive: true }} data={{labels: ['เงินสด', 'QR Code'], datasets: [{ label: 'จำนวนบิล', data: [paymentSales.cash.count, paymentSales.qr.count], backgroundColor: ['#34d399', '#60a5fa'] }]}} />
                   ) : <p>ไม่มีข้อมูล</p>}
                </div>
            </div>
        )
    };

    const DiscountReport = ({ orders }: { orders: Order[] }) => {
        const discountedOrders = useMemo(() => orders.filter(o => o.discountValue > 0 && o.status !== 'cancelled'), [orders]);
        const totalDiscount = useMemo(() => discountedOrders.reduce((sum, o) => sum + o.discountValue, 0), [discountedOrders]);

        return (
            <div>
                <div className="report-header"><h1>รายงานส่วนลด</h1></div>
                 <div className="summary-cards">
                    <div className="summary-card"><div className="summary-card-title">ส่วนลดทั้งหมด</div><div className="summary-card-value">฿{totalDiscount.toFixed(2)}</div></div>
                    <div className="summary-card"><div className="summary-card-title">จำนวนบิลที่ใช้ส่วนลด</div><div className="summary-card-value">{discountedOrders.length}</div></div>
                </div>
                <table className="report-table">
                    <thead><tr><th>เลขที่บิล</th><th>เวลา</th><th>ยอดก่อนลด</th><th>ส่วนลด</th><th>ยอดสุทธิ</th></tr></thead>
                    <tbody>
                        {discountedOrders.map(order => (
                            <tr key={order.id}>
                                <td>{order.id}</td>
                                <td>{new Date(order.timestamp).toLocaleString('th-TH')}</td>
                                <td>฿{order.subtotal.toFixed(2)}</td>
                                <td>-฿{order.discountValue.toFixed(2)}</td>
                                <td>฿{order.total.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    };
    
    const ActivityLogReport = ({ log }: { log: LogEntry[] }) => {
        return (
            <div>
                <div className="report-header"><h1>ประวัติการแก้ไข</h1></div>
                <table className="report-table">
                    <thead><tr><th>เวลา</th><th>การดำเนินการ</th></tr></thead>
                    <tbody>
                        {log.map((entry, index) => (
                            <tr key={index}>
                                <td>{new Date(entry.timestamp).toLocaleString('th-TH')}</td>
                                <td>{entry.action}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    };

    const CancelledBillsReport = ({ orders }: { orders: Order[] }) => {
        const cancelled = useMemo(() => orders.filter(o => o.status === 'cancelled').sort((a,b) => (b.cancelledAt ? new Date(b.cancelledAt).getTime() : 0) - (a.cancelledAt ? new Date(a.cancelledAt).getTime() : 0)), [orders]);

        return (
            <div>
                <div className="report-header"><h1>รายงานการลบบิล</h1></div>
                <table className="report-table">
                    <thead><tr><th>เลขที่บิล</th><th>เวลาที่สร้าง</th><th>เวลายกเลิก</th><th>ยอดรวม</th></tr></thead>
                    <tbody>
                        {cancelled.length === 0 && <tr><td colSpan={4} style={{textAlign: 'center'}}>ไม่มีบิลที่ถูกยกเลิก</td></tr>}
                        {cancelled.map(order => (
                            <tr key={order.id} className="cancelled-bill">
                                <td>{order.id}</td>
                                <td>{new Date(order.timestamp).toLocaleString('th-TH')}</td>
                                <td>{order.cancelledAt ? new Date(order.cancelledAt).toLocaleString('th-TH') : 'N/A'}</td>
                                <td>฿{order.total.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    // --- Settings Screen Components ---
    const SettingsScreen = () => {
        type SettingTab = 'general' | 'receipts' | 'features' | 'payments' | 'security';
        const [activeTab, setActiveTab] = useState<SettingTab>('general');
        
        const tabs: {id: SettingTab, name: string, icon: string}[] = [
          {id: 'general', name: 'ตั้งค่าทั่วไป', icon: 'storefront'},
          {id: 'receipts', name: 'ใบเสร็จ', icon: 'print'},
          {id: 'features', name: 'โหมด & การใช้งาน', icon: 'toggle_on'},
          {id: 'payments', name: 'ประเภทการชำระเงิน', icon: 'credit_card'},
          {id: 'security', name: 'ผู้ใช้ & ความปลอดภัย', icon: 'lock'},
        ];

        return (
            <div className="settings-screen">
                <nav className="settings-nav">
                    <h2>ตั้งค่า</h2>
                    <ul className="settings-nav-list">
                        {tabs.map(tab => (
                             <li key={tab.id} className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
                                <span className="material-symbols-outlined">{tab.icon}</span>
                                <span>{tab.name}</span>
                            </li>
                        ))}
                    </ul>
                </nav>
                <main className="settings-content">
                    <div className="settings-page-header">
                        <h1>{tabs.find(t => t.id === activeTab)?.name}</h1>
                    </div>
                    {activeTab === 'general' && <GeneralSettings settings={shopSettings} onSettingsChange={setShopSettings} isAdminMode={isAdminMode} />}
                    {activeTab === 'receipts' && <ReceiptSettings settings={shopSettings} onSettingsChange={setShopSettings} isAdminMode={isAdminMode} offlineLogo={offlineReceiptLogo} setOfflineLogo={setOfflineReceiptLogo} offlinePromo={offlineReceiptPromo} setOfflinePromo={setOfflineReceiptPromo} />}
                    {activeTab === 'features' && <FeatureSettings settings={shopSettings} onSettingsChange={setShopSettings} isAdminMode={isAdminMode} logAction={logAction} />}
                    {activeTab === 'security' && <SecuritySettings currentPassword={adminPassword} onPasswordChange={handlePasswordChange} />}
                    {['payments'].includes(activeTab) && (
                        <div className="settings-card placeholder">
                            <h3>{tabs.find(t => t.id === activeTab)?.name}</h3>
                            <p>ส่วนนี้ยังอยู่ในระหว่างการพัฒนา</p>
                        </div>
                    )}
                </main>
            </div>
        )
    }

    const GeneralSettings = ({ settings, onSettingsChange, isAdminMode }: { settings: ShopSettings, onSettingsChange: (s: ShopSettings) => void, isAdminMode: boolean }) => {
        const [localSettings, setLocalSettings] = useState(settings);

        useEffect(() => {
            if (!isAdminMode) { setLocalSettings(settings); }
        }, [isAdminMode, settings]);

        const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
            const { id, value } = e.target;
            setLocalSettings(prev => ({ ...prev, [id]: value }));
        };

        const handleSave = () => {
            onSettingsChange(localSettings);
            alert('บันทึกการตั้งค่าทั่วไปแล้ว');
        };

        return (
            <div className="settings-card">
                <h3>ข้อมูลร้านค้า</h3>
                <div className="form-group">
                    <label htmlFor="shopName">ชื่อร้าน</label>
                    <input type="text" id="shopName" value={localSettings.shopName} onChange={handleChange} disabled={!isAdminMode} />
                </div>
                <div className="form-group">
                    <label htmlFor="address">ที่อยู่</label>
                    <textarea id="address" rows={3} value={localSettings.address} onChange={handleChange} disabled={!isAdminMode}></textarea>
                </div>
                <h3>การตั้งค่าท้องถิ่น</h3>
                <div className="form-group">
                    <label htmlFor="currency">สกุลเงิน</label>
                    <select id="currency" defaultValue="THB" disabled={!isAdminMode}>
                        <option value="THB">บาท (THB)</option>
                        <option value="USD">ดอลลาร์สหรัฐ (USD)</option>
                    </select>
                </div>
                {isAdminMode && <button className="action-button" onClick={handleSave}>บันทึกการเปลี่ยนแปลง</button>}
            </div>
        );
    };

    const FeatureSettings = ({ settings, onSettingsChange, isAdminMode, logAction }: { settings: ShopSettings, onSettingsChange: (s: ShopSettings) => void, isAdminMode: boolean, logAction: (action: string) => void }) => {
        const [localSettings, setLocalSettings] = useState(settings);

        useEffect(() => {
            if (!isAdminMode) { setLocalSettings(settings); }
        }, [isAdminMode, settings]);
        
        const handleChange = (key: keyof ShopSettings, value: any) => {
            setLocalSettings(prev => ({ ...prev, [key]: value }));
        };

        const handleSave = () => {
            onSettingsChange(localSettings);
            logAction('บันทึกการตั้งค่าโหมดการใช้งาน');
            alert('บันทึกการตั้งค่าโหมดการใช้งานแล้ว');
        };

        return (
            <div className="settings-card">
                <h3>โหมดการใช้งานและหน้าจอ</h3>
                <div className="form-group">
                    <label>โหมดการป้อนข้อมูลหลัก</label>
                    <p className="text-secondary" style={{marginBottom: '0.75rem', fontSize: '0.9rem'}}>เลือกโหมดที่เหมาะสมกับอุปกรณ์ของคุณ</p>
                    <div className="radio-group">
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="interactionMode"
                                value="desktop"
                                checked={localSettings.interactionMode === 'desktop'}
                                onChange={() => handleChange('interactionMode', 'desktop')}
                                disabled={!isAdminMode}
                            />
                            <span className="radio-custom"></span>
                            <span>
                                <strong>เดสก์ท็อป (เมาส์และคีย์บอร์ด)</strong>
                                <small>เหมาะสำหรับคอมพิวเตอร์ที่มีเมาส์และคีย์บอร์ด</small>
                            </span>
                        </label>
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="interactionMode"
                                value="touch"
                                checked={localSettings.interactionMode === 'touch'}
                                onChange={() => handleChange('interactionMode', 'touch')}
                                disabled={!isAdminMode}
                            />
                             <span className="radio-custom"></span>
                             <span>
                                <strong>หน้าจอสัมผัส (แท็บเล็ต/มือถือ)</strong>
                                <small>ปรับปุ่มและระยะห่างให้ใหญ่ขึ้นเพื่อการสัมผัส</small>
                            </span>
                        </label>
                    </div>
                </div>

                <div className="form-group">
                    <label>การนำทางด้วยคีย์บอร์ด</label>
                     <p className="text-secondary" style={{marginBottom: '0.75rem', fontSize: '0.9rem'}}>เปิดเพื่อแสดงไฮไลท์และใช้งานคีย์บอร์ดเพื่อเลือกเมนู (เหมาะสำหรับโหมดเดสก์ท็อป)</p>
                    <div className="vat-toggle">
                        <span>ปิด/เปิดใช้งานไฮไลท์</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={localSettings.isKeyboardNavEnabled}
                                onChange={(e) => handleChange('isKeyboardNavEnabled', e.target.checked)}
                                disabled={!isAdminMode}
                            />
                            <span className="slider"></span>
                        </label>
                    </div>
                </div>

                 <div className="form-group">
                    <label>การปรับหน้าจอ (Responsive)</label>
                    <p className="text-secondary" style={{fontSize: '0.9rem'}}>
                        แอปพลิเคชันถูกออกแบบมาให้ปรับขนาดตามความกว้างของหน้าจอโดยอัตโนมัติ (Smart Display) เพื่อให้แสดงผลได้ดีที่สุดทั้งในโหมดแนวนอน (แนะนำ) และแนวตั้งบนอุปกรณ์ต่างๆ
                    </p>
                </div>

                {isAdminMode && <button className="action-button" onClick={handleSave}>บันทึกการเปลี่ยนแปลง</button>}
            </div>
        );
    };

    const UploadIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" style={{width: '1.25rem', height: '1.25rem', marginRight: '0.5rem'}} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
    );
    
    const ReceiptSettings = ({ settings, onSettingsChange, isAdminMode, offlineLogo, setOfflineLogo, offlinePromo, setOfflinePromo }: { 
        settings: ShopSettings, 
        onSettingsChange: (s: ShopSettings) => void, 
        isAdminMode: boolean,
        offlineLogo: string | null, 
        setOfflineLogo: (d: string | null) => void, 
        offlinePromo: string | null, 
        setOfflinePromo: (d: string | null) => void 
    }) => {
        const [localSettings, setLocalSettings] = useState(settings);
    
        useEffect(() => {
            if (!isAdminMode) { setLocalSettings(settings); }
        }, [isAdminMode, settings]);
    
        const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const { id, value } = e.target;
            const target = e.target as HTMLInputElement;
            setLocalSettings(prev => ({ 
                ...prev, 
                [id]: target.type === 'number' ? Number(value) || 0 : value 
            }));
        };
        
        const handleSave = () => {
            onSettingsChange(localSettings);
            logAction('บันทึกการตั้งค่าใบเสร็จ');
            alert('บันทึกการตั้งค่าใบเสร็จแล้ว');
        };
    
        const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, stateSetter: (d: string | null) => void, storageKey: string) => {
            const file = e.target.files?.[0];
            if (!file) return;
    
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result as string;
                stateSetter(dataUrl);
                localStorage.setItem(storageKey, dataUrl);
                alert(`อัปโหลดและบันทึกรูปสำหรับ "${storageKey}" เรียบร้อยแล้ว!`);
            };
            reader.readAsDataURL(file);
        };
    
        const handleImageDelete = (stateSetter: (d: string | null) => void, storageKey: string) => {
            if (window.confirm(`คุณต้องการลบรูปภาพออฟไลน์สำหรับ "${storageKey}" หรือไม่?`)) {
                stateSetter(null);
                localStorage.removeItem(storageKey);
                alert(`ลบรูปภาพ "${storageKey}" เรียบร้อยแล้ว`);
            }
        };
    
        return (
            <div className="settings-card">
                <h3>การตั้งค่าเครื่องพิมพ์</h3>
                <div className="form-group">
                    <label htmlFor="printer">เลือกเครื่องพิมพ์ใบเสร็จ</label>
                    <select id="printer" disabled={!isAdminMode}>
                        <option>พิมพ์ผ่านเบราว์เซอร์</option>
                        <option>Epson TM-T88VI (Network)</option>
                        <option>STAR TSP100 (USB)</option>
                    </select>
                </div>
                <div className="form-group">
                    <label>พิมพ์ใบเสร็จอัตโนมัติ</label>
                    <div className="vat-toggle">
                        <span>ปิด/เปิด</span>
                        <label className="switch"><input type="checkbox" defaultChecked disabled={!isAdminMode} /><span className="slider"></span></label>
                    </div>
                </div>
    
                <div style={{borderTop: '1px solid var(--border-color)', margin: '2rem 0'}}></div>
    
                <h3>รูปแบบใบเสร็จ (ออนไลน์)</h3>
                <p className="text-secondary" style={{marginBottom: '1rem', fontSize: '0.9rem'}}>ใช้รูปภาพจาก URL ภายนอก (ต้องใช้อินเทอร์เน็ต)</p>
                
                <div className="form-group">
                    <label htmlFor="logoUrl">URL โลโก้</label>
                    <input type="text" id="logoUrl" value={localSettings.logoUrl} onChange={handleChange} disabled={!isAdminMode} placeholder="https://example.com/logo.png" />
                </div>
                <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                        <label htmlFor="logoWidth">ความกว้างโลโก้ (px)</label>
                        <input type="number" id="logoWidth" value={localSettings.logoWidth} onChange={handleChange} disabled={!isAdminMode} />
                    </div>
                    <div>
                        <label htmlFor="logoHeight">ความสูงโลโก้ (px)</label>
                        <input type="number" id="logoHeight" value={localSettings.logoHeight} onChange={handleChange} disabled={!isAdminMode} />
                    </div>
                </div>
    
                <div className="form-group">
                    <label htmlFor="promoUrl">URL รูปภาพท้ายใบเสร็จ</label>
                    <input type="text" id="promoUrl" value={localSettings.promoUrl} onChange={handleChange} disabled={!isAdminMode} placeholder="https://example.com/promo.gif" />
                </div>
                 <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                        <label htmlFor="promoWidth">ความกว้างรูปท้ายใบเสร็จ (px)</label>
                        <input type="number" id="promoWidth" value={localSettings.promoWidth} onChange={handleChange} disabled={!isAdminMode} />
                    </div>
                    <div>
                        <label htmlFor="promoHeight">ความสูงรูปท้ายใบเสร็จ (px)</label>
                        <input type="number" id="promoHeight" value={localSettings.promoHeight} onChange={handleChange} disabled={!isAdminMode} />
                    </div>
                </div>
                
                <div className="form-group">
                    <label htmlFor="headerText">ข้อความส่วนหัว</label>
                    <textarea id="headerText" rows={2} value={localSettings.headerText} onChange={handleChange} disabled={!isAdminMode}></textarea>
                </div>
                 <div className="form-group">
                    <label htmlFor="footerText">ข้อความส่วนท้าย</label>
                    <textarea id="footerText" rows={2} value={localSettings.footerText} onChange={handleChange} disabled={!isAdminMode}></textarea>
                </div>
    
                <div style={{borderTop: '1px solid var(--border-color)', margin: '2rem 0'}}></div>
    
                <h3>รูปแบบใบเสร็จ (ออฟไลน์)</h3>
                <p className="text-secondary" style={{marginBottom: '1rem', fontSize: '0.9rem'}}>อัปโหลดรูปจากเครื่องเพื่อใช้งานโดยไม่ต้องต่ออินเทอร์เน็ต รูปที่อัปโหลดจะถูกใช้ก่อน URL ออนไลน์</p>
    
                <div className="form-group">
                    <label>โลโก้ (ออฟไลน์)</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <label className="action-button" style={{cursor: isAdminMode ? 'pointer' : 'not-allowed', opacity: isAdminMode ? 1 : 0.6}}>
                            <UploadIcon />
                            <span>เลือกไฟล์</span>
                            <input type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, setOfflineLogo, 'takoyaki_pos_offline_logo')} disabled={!isAdminMode}/>
                        </label>
                        {offlineLogo && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <img src={offlineLogo} alt="Preview" style={{ height: '40px', width: 'auto', background: 'white', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-color)' }} />
                                <span style={{ color: 'var(--success-color)', fontSize: '0.875rem' }}>มีรูปที่บันทึกไว้</span>
                                {isAdminMode && <button type="button" onClick={() => handleImageDelete(setOfflineLogo, 'takoyaki_pos_offline_logo')} style={{color: 'var(--danger-color)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', textDecoration: 'underline'}}>ลบ</button>}
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="form-group">
                    <label>รูปภาพท้ายใบเสร็จ (ออฟไลน์)</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                         <label className="action-button" style={{cursor: isAdminMode ? 'pointer' : 'not-allowed', opacity: isAdminMode ? 1 : 0.6}}>
                            <UploadIcon />
                            <span>เลือกไฟล์</span>
                            <input type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, setOfflinePromo, 'takoyaki_pos_offline_promo')} disabled={!isAdminMode} />
                        </label>
                        {offlinePromo && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <img src={offlinePromo} alt="Preview" style={{ height: '40px', width: 'auto', background: 'white', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-color)' }} />
                                <span style={{ color: 'var(--success-color)', fontSize: '0.875rem' }}>มีรูปที่บันทึกไว้</span>
                                {isAdminMode && <button type="button" onClick={() => handleImageDelete(setOfflinePromo, 'takoyaki_pos_offline_promo')} style={{color: 'var(--danger-color)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', textDecoration: 'underline'}}>ลบ</button>}
                            </div>
                        )}
                    </div>
                </div>
    
                {isAdminMode && <button className="action-button" onClick={handleSave}>บันทึกการเปลี่ยนแปลงทั้งหมด</button>}
            </div>
        );
    };
    
    const SecuritySettings = ({ currentPassword, onPasswordChange }: { currentPassword: string, onPasswordChange: (newPass: string) => boolean }) => {
        const [oldPass, setOldPass] = useState('');
        const [newPass, setNewPass] = useState('');
        const [confirmPass, setConfirmPass] = useState('');
        const [error, setError] = useState('');

        const handleSubmit = (e: React.FormEvent) => {
            e.preventDefault();
            setError('');
            if (oldPass !== currentPassword) {
                setError('รหัสผ่านปัจจุบันไม่ถูกต้อง');
                return;
            }
            if (newPass.length < 4) {
                setError('รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร');
                return;
            }
            if (newPass !== confirmPass) {
                setError('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
                return;
            }
            if (onPasswordChange(newPass)) {
                setOldPass('');
                setNewPass('');
                setConfirmPass('');
            }
        };

        return (
            <div className="settings-card">
                <h3>เปลี่ยนรหัสผ่านผู้ดูแล</h3>
                 <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="oldPass">รหัสผ่านปัจจุบัน</label>
                        <input type="password" id="oldPass" value={oldPass} onChange={e => setOldPass(e.target.value)} required />
                    </div>
                    <div className="form-group">
                        <label htmlFor="newPass">รหัสผ่านใหม่</label>
                        <input type="password" id="newPass" value={newPass} onChange={e => setNewPass(e.target.value)} required />
                    </div>
                     <div className="form-group">
                        <label htmlFor="confirmPass">ยืนยันรหัสผ่านใหม่</label>
                        <input type="password" id="confirmPass" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} required />
                    </div>
                    {error && <p className="error-message">{error}</p>}
                    <button type="submit" className="action-button">บันทึกรหัสผ่านใหม่</button>
                </form>
            </div>
        );
    };


    return (
        <div className={`app-container ${shopSettings.interactionMode === 'touch' ? 'touch-mode' : ''}`}>
            <TopNav />
            {view === 'pos' && (
                <main className="pos-view">
                    <div className={`pos-view-overlay ${isOrderPanelOpen ? 'is-visible' : ''}`} onClick={() => setIsOrderPanelOpen(false)}></div>
                    <CategoryColumn />
                    <MenuGrid />
                    <OrderPanel />
                </main>
            )}
            {view === 'orders' && (
                <OrderManagementScreen 
                    kitchenOrders={kitchenOrders}
                    completedOrders={completedOrders}
                    onUpdateStatus={handleUpdateOrderStatus}
                    onCompleteOrder={handleCompleteOrder}
                    isAdminMode={isAdminMode}
                    onCancelBill={handleCancelBill}
                />
            )}
            {view === 'reports' && <ReportsScreen />}
            {view === 'settings' && <SettingsScreen />}
            
            {showPaymentModal && <PaymentModal />}
            {showReceiptModal && <ReceiptModal show={showReceiptModal} onClose={() => setShowReceiptModal(false)} orderData={receiptData} shopSettings={shopSettings} offlineLogo={offlineReceiptLogo} offlinePromo={offlineReceiptPromo} />}
            <AdminLoginModal show={showAdminLoginModal} onClose={() => setShowAdminLoginModal(false)} onLogin={handleAdminLogin} />
            <MenuItemModal show={showMenuItemModal} onClose={() => setShowMenuItemModal(false)} onSave={handleSaveMenuItem} item={editingItem} categories={categories} />
            {showStartShiftModal && <StartShiftModal />}
            {showPaidInOutModal && <PaidInOutModal />}
            {showEndShiftModal && <EndShiftModal summary={shiftSummaryData} onClose={() => setShowEndShiftModal(false)} onConfirm={handleEndShift} />}
        </div>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
