/* ============================================================
   BillSplitter — script.js
   Pure client-side receipt scanner and bill splitting tool.
   ============================================================ */

'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────────

let state = {
    items: [],          // [{ id, name, price }]
    people: [],         // [{ id, name }]
    assignments: {},    // { itemId: [personId, ...] }
    tip: 0,             // tip amount in currency units
    receiptTotal: null, // actual total printed on the receipt (user-entered)
};

let currentView = 0;
let ocrWorker = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // File input listener
    document.getElementById('fileInput').addEventListener('change', onFileSelected);

    // Drag-over styling for upload zone
    const zone = document.getElementById('uploadZone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) handleFile(file);
    });

    // Static event listeners
    document.getElementById('btnScan')?.addEventListener('click', runOCR);
    document.getElementById('btnSkipToItems')?.addEventListener('click', skipToItems);
    document.getElementById('btnCopyTotal')?.addEventListener('click', copyTotalToReceipt);
    document.getElementById('btnAddPerson')?.addEventListener('click', addPerson);
    document.getElementById('btnSplitAll')?.addEventListener('click', splitAllEqually);
    document.getElementById('btnResetAssignments')?.addEventListener('click', resetAssignments);
    document.getElementById('tipAmount')?.addEventListener('input', onTipInput);
    document.getElementById('receiptTotalInput')?.addEventListener('input', onReceiptTotalInput);

    document.getElementById('personNameInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') addPerson();
    });

    document.querySelectorAll('.tip-pct-btn').forEach(btn => {
        btn.addEventListener('click', e => setTipPct(Number(e.target.dataset.pct)));
    });

    document.querySelectorAll('[data-goto]').forEach(btn => {
        btn.addEventListener('click', e => goTo(Number(e.target.dataset.goto)));
    });

    // Event Delegation for dynamically rendered elements and common actions
    document.body.addEventListener('click', e => {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;
        const action = actionBtn.dataset.action;

        if (action === 'toggleItem') toggleItemDisabled(actionBtn.dataset.id);
        else if (action === 'removePerson') removePerson(actionBtn.dataset.id);
        else if (action === 'toggleAssign') toggleAssign(actionBtn.dataset.item, actionBtn.dataset.person);
        else if (action === 'startOver') startOver();
        else if (action === 'addItem') addItem();
    });

    document.body.addEventListener('input', e => {
        if (e.target.dataset.action === 'onNameInput') onNameInput(e.target, e.target.dataset.id);
        else if (e.target.dataset.action === 'onPriceInput') onPriceInput(e.target, e.target.dataset.id);
    });

    document.body.addEventListener('mouseover', e => {
        const row = e.target.closest('[data-hover]');
        if (row && row.dataset.hover !== "undefined") reviewRowHover(Number(row.dataset.hover));
    });

    document.body.addEventListener('mouseout', e => {
        const row = e.target.closest('[data-hover]');
        if (row) reviewRowHoverEnd();
    });
});

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function checkMismatch() {
    if (state.receiptTotal == null) return false;
    return Math.abs(getSubtotal() - state.receiptTotal) > 0.05;
}

function updatePeopleButton() {
    const btnToPeople = document.getElementById('btnToPeople');
    if (!btnToPeople) return;

    const hasItems = state.items.filter(i => !i.disabled).length > 0;
    if (!hasItems) {
        btnToPeople.disabled = true;
        btnToPeople.textContent = 'People → (Add an item first)';
        return;
    }

    if (checkMismatch()) {
        btnToPeople.disabled = true;
        btnToPeople.textContent = 'People → (Totals must match)';
        return;
    }

    btnToPeople.disabled = false;
    btnToPeople.textContent = 'People →';
}

function goTo(step) {
    // Validate before leaving step 2 (people)
    if (step > 2 && currentView === 2) {
        if (state.people.length === 0) {
            return; // Blocked by UI button disabled state, but keep safeguard
        }
    }

    document.getElementById(`view-${currentView}`).classList.remove('active');
    currentView = step;
    document.getElementById(`view-${step}`).classList.add('active');

    updateStepIndicator();

    if (step === 3) {
        renderAssign();
        renderRunningTotals();
    }

    if (step === 1) renderItems();
    if (step === 2) renderPeople();
    if (step === 4) renderSummary();

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStepIndicator() {
    for (let i = 0; i < 5; i++) {
        const dot = document.getElementById(`dot-${i}`);
        dot.classList.remove('active', 'done');
        if (i < currentView) dot.classList.add('done');
        else if (i === currentView) dot.classList.add('active');
    }
    for (let i = 0; i < 4; i++) {
        const line = document.getElementById(`line-${i}`);
        line.classList.toggle('done', i < currentView);
    }
}

// ─── FILE / OCR ───────────────────────────────────────────────────────────────

function onFileSelected(e) {
    const file = e.target.files[0];
    if (file) handleFile(file);
}

function handleFile(file) {
    const reader = new FileReader();
    reader.onload = ev => {
        const img = document.getElementById('previewImg');
        img.src = ev.target.result;
        img.classList.add('visible');

        // Hide upload zone and manual entry after selection
        document.getElementById('uploadZone').classList.add('hidden');
        const manualEntryRow = document.getElementById('manualEntryRow');
        if (manualEntryRow) manualEntryRow.classList.add('hidden');

        // Automatically start scanning the receipt
        runOCR();
    };
    reader.readAsDataURL(file);
    // Store file reference for OCR
    window._receiptFile = file;
}

async function runOCR() {
    if (ocrWorker) { console.warn('OCR already running — ignoring duplicate call.'); return; }
    const file = window._receiptFile;
    if (!file) return;

    const progress = document.getElementById('ocrProgress');
    const status = document.getElementById('ocrStatus');
    const btnScan = document.getElementById('btnScan');

    progress.classList.add('visible');
    btnScan.disabled = true;

    try {
        status.textContent = 'Loading OCR engine…';

        const { createWorker } = Tesseract;
        ocrWorker = await createWorker('eng+fra', 1, {
            logger: m => {
                const pBarContainer = document.querySelector('.progress-bar-container');
                const pBarFill = document.getElementById('ocrProgressBarFill');
                if (m.status === 'recognizing text') {
                    status.textContent = 'Recognizing…';
                    if (pBarContainer) pBarContainer.classList.add('visible');
                    if (pBarFill) pBarFill.style.width = `${Math.round(m.progress * 100)}%`;
                } else if (m.status) {
                    status.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
                    if (pBarContainer) pBarContainer.classList.remove('visible');
                }
            }
        });

        // PSM 6 = assume a single uniform block of text (good for receipts)
        await ocrWorker.setParameters({
            tessedit_pageseg_mode: '6',
            // Allow digits, letters, common punctuation found on receipts
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzàâäéèêëîïôùûüçÀÂÉÈÊÎÏÔÙÛÜÇ 0123456789.,%-/\':',
        });

        status.textContent = 'Extracting text…';
        const { data } = await ocrWorker.recognize(file);

        // Store raw OCR text + line bounding boxes for visual map
        state._ocrRaw = data.text;
        state._ocrLines = data.lines || [];
        console.log('[OCR raw output]\n', data.text);
        console.log('[OCR lines with bbox]', data.lines);

        status.textContent = 'Parsing items…';
        const { parsed, taggedLines, detectedTotal } = parseItemsWithTags(data.text, data.lines);
        state._ocrTaggedLines = taggedLines;
        state.items = parsed.length > 0 ? parsed : [makeItem('', 0)];

        // Auto-fill receipt total from OCR if not already set by user
        if (detectedTotal != null && state.receiptTotal == null) {
            state.receiptTotal = detectedTotal;
            const rtInput = document.getElementById('receiptTotalInput');
            if (rtInput) rtInput.value = detectedTotal.toFixed(2);
        }

        progress.classList.remove('visible');
        const pBarContainer = document.querySelector('.progress-bar-container');
        if (pBarContainer) pBarContainer.classList.remove('visible');
        btnScan.disabled = false;
        btnScan.textContent = '🔍 Scan Receipt';

        // Load the image into _ocrMapImg so the review canvas has it,
        // then automatically go to the next step (Review Items)
        const img = document.getElementById('previewImg');
        if (img.src) {
            const image = new Image();
            image.onload = () => {
                _ocrMapImg = image;
                goTo(1);
            };
            image.src = img.src;
        } else {
            goTo(1);
        }

    } catch (err) {
        console.error('OCR error:', err);
        progress.classList.remove('visible');
        const pBarContainer = document.querySelector('.progress-bar-container');
        if (pBarContainer) pBarContainer.classList.remove('visible');
        btnScan.disabled = false;
        btnScan.textContent = '🔍 Scan Receipt';
        alert('OCR failed. Please enter items manually.');
        state.items = [makeItem('', 0)];
        goTo(1);
    } finally {
        if (ocrWorker) {
            try {
                await ocrWorker.terminate();
            } catch (e) {
                console.error('Failed to terminate worker:', e);
            }
            ocrWorker = null;
        }
    }
}

function skipToItems() {
    if (state.items.length === 0) {
        state.items = [makeItem('Item 1', 0)];
    }
    // Clear OCR state so the plain editor is shown instead of the split panel
    _ocrMapImg = null;
    state._ocrTaggedLines = [];
    goTo(1);
}

// ─── ITEM PARSING ─────────────────────────────────────────────────────────────

function cleanName(s) {
    // Remove leading quantity: "1 ", "2 ", "1x ", "2.00 ", "2,00x ", etc.
    s = s.replace(/^\d+([.,]\d+)?\s*[xX]?\s+/, '');
    // Remove leading/trailing OCR noise (non-word chars that aren't accented letters)
    s = s.replace(/^[^\w\u00C0-\u024F]+/, '').replace(/[^\w\u00C0-\u024F.]+$/, '');
    // Collapse internal whitespace
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}


// ─── OCR VISUAL MAP ───────────────────────────────────────────────────────────

/**
 * Like parseItems but also returns tag metadata for each OCR line:
 *   type: 'item' | 'skip' | 'noise'
 *   parsedName, parsedPrice (if item)
 *   text: raw OCR line text
 *   bbox: {x0,y0,x1,y1} from Tesseract
 */
function parseItemsWithTags(text, ocrLines) {
    const tempTags = [];

    const SKIP_RE = /\b(total|subtotal|tax(es)?|tva|mwst|vat|service charge|gratuity|change|cash|card(s)?|thank|welcome|table|tisch|date|time|receipt|invoice|order|espece(s)?|espèce(s)?|monnaie|rendu|pourboire|rounding|arrondi|incl\.|couvert|bon(s)?)\b/i;
    const DISCOUNT_RE = /\d+[.,]?\d*\s*%\s*(rabatt|remise|discount|reduction|offert|reduc)/i;
    const PRICE_TOKEN_RE = /(?:^|[^\d])(\d{1,5}[.,]\d{2})(?=[^\d]|$)/g;

    // Sort OCR lines by y0 coordinate to guarantee correct physical top-to-bottom order on the receipt.
    // If they are on the same line (y0 difference < 5px), sort left-to-right (x0) to avoid overlapping.
    const sortedLines = [...(ocrLines || [])].sort((a, b) => {
        const yA = (a.bbox && a.bbox.y0) || 0;
        const yB = (b.bbox && b.bbox.y0) || 0;
        if (Math.abs(yA - yB) < 5) {
            const xA = (a.bbox && a.bbox.x0) || 0;
            const xB = (b.bbox && b.bbox.x0) || 0;
            return xA - xB;
        }
        return yA - yB;
    });

    for (const line of sortedLines) {
        const lineText = (line.text || '').trim();
        if (lineText.length < 3) continue;

        const bbox = line.bbox || null;
        const tag = { text: lineText, bbox, type: 'noise', parsedName: null, parsedPrice: null, parsedItem: null };

        if (SKIP_RE.test(lineText)) { tag.type = 'skip'; tempTags.push(tag); continue; }
        if (DISCOUNT_RE.test(lineText)) { tag.type = 'skip'; tempTags.push(tag); continue; }
        if (/^\d+[.,]\d+\s*%/.test(lineText)) { tag.type = 'skip'; tempTags.push(tag); continue; }

        const prices = [];
        let m;
        PRICE_TOKEN_RE.lastIndex = 0;
        while ((m = PRICE_TOKEN_RE.exec(lineText)) !== null) {
            const rawNum = m[1].replace(/[^0-9]/g, '');
            const val = parseFloat(rawNum.slice(0, -2) + '.' + rawNum.slice(-2));
            if (!isNaN(val) && val > 0 && val < 10000) {
                prices.push({ val, index: m.index, raw: m[0] });
            }
        }

        if (prices.length > 1) {
            const firstPrice = prices[0];
            const prefix = lineText.slice(0, firstPrice.index).trim();
            if (prefix === '' || /^[^\w]+$/.test(prefix)) {
                prices.shift();
            }
        }

        if (prices.length === 0) { tempTags.push(tag); continue; }

        const totalPrice = prices[prices.length - 1];
        const nameRaw = lineText.slice(0, prices[0].index).trim();
        const name = cleanName(nameRaw);

        if (name.length >= 2) {
            tag.type = 'item';
            tag.parsedName = name;
            tag.parsedPrice = totalPrice.val;
            tag.parsedItem = makeItem(name, totalPrice.val);
            tempTags.push(tag);
            continue;
        }

        // Fallback
        if (prices.length === 1) {
            const afterPrice = lineText.slice(prices[0].index + prices[0].raw.length).trim();
            const nameAfter = cleanName(afterPrice);
            if (nameAfter.length >= 2) {
                tag.type = 'item';
                tag.parsedName = nameAfter;
                tag.parsedPrice = totalPrice.val;
                tag.parsedItem = makeItem(nameAfter, totalPrice.val);
                tempTags.push(tag);
                continue;
            }
        }

        // Has price but no name -> price-only line
        tag.type = 'price-only';
        tag.parsedPrice = totalPrice.val;
        tempTags.push(tag);
    }

    // Helper to check if two bounding boxes are on the same physical line (row)
    const areOnSameRow = (tagA, tagB) => {
        if (!tagA.bbox || !tagB.bbox) return false;
        const boxA = tagA.bbox;
        const boxB = tagB.bbox;
        const yTop = Math.max(boxA.y0, boxB.y0);
        const yBottom = Math.min(boxA.y1, boxB.y1);
        const verticalIntersection = Math.max(0, yBottom - yTop);
        const heightA = boxA.y1 - boxA.y0;
        const heightB = boxB.y1 - boxB.y0;
        const minHeight = Math.min(heightA, heightB);
        return minHeight > 0 && (verticalIntersection / minHeight) > 0.50;
    };

    // Merge name-only lines and price-only lines on the same row
    for (let i = 0; i < tempTags.length; i++) {
        const tagA = tempTags[i];
        if (tagA.ignored) continue;

        for (let j = i + 1; j < tempTags.length; j++) {
            const tagB = tempTags[j];
            if (tagB.ignored) continue;

            if (areOnSameRow(tagA, tagB)) {
                let nameTag = null;
                let priceTag = null;

                if (tagA.type === 'noise' && tagB.type === 'price-only') {
                    nameTag = tagA;
                    priceTag = tagB;
                } else if (tagB.type === 'noise' && tagA.type === 'price-only') {
                    nameTag = tagB;
                    priceTag = tagA;
                }

                if (nameTag && priceTag) {
                    const cleanedName = cleanName(nameTag.text);
                    if (cleanedName.length >= 2) {
                        nameTag.type = 'item';
                        nameTag.parsedName = cleanedName;
                        nameTag.parsedPrice = priceTag.parsedPrice;
                        nameTag.parsedItem = makeItem(cleanedName, priceTag.parsedPrice);

                        if (nameTag.bbox && priceTag.bbox) {
                            nameTag.bbox = {
                                x0: Math.min(nameTag.bbox.x0, priceTag.bbox.x0),
                                y0: Math.min(nameTag.bbox.y0, priceTag.bbox.y0),
                                x1: Math.max(nameTag.bbox.x1, priceTag.bbox.x1),
                                y1: Math.max(nameTag.bbox.y1, priceTag.bbox.y1)
                            };
                        } else if (priceTag.bbox) {
                            nameTag.bbox = priceTag.bbox;
                        }

                        priceTag.ignored = true;
                        break;
                    }
                }
            }
        }
    }

    // Convert any remaining price-only lines to item lines with fallback name
    for (const tag of tempTags) {
        if (tag.type === 'price-only' && !tag.ignored) {
            tag.type = 'item';
            const fallbackName = "Item";
            tag.parsedName = fallbackName;
            tag.parsedItem = makeItem(fallbackName, tag.parsedPrice);
        }
    }

    // Helper functions for overlap filtering
    const tagsOverlap = (tagA, tagB) => {
        if (!tagA.bbox || !tagB.bbox) return false;
        const boxA = tagA.bbox;
        const boxB = tagB.bbox;

        // Calculate vertical intersection
        const yTop = Math.max(boxA.y0, boxB.y0);
        const yBottom = Math.min(boxA.y1, boxB.y1);
        const verticalIntersection = Math.max(0, yBottom - yTop);

        const heightA = boxA.y1 - boxA.y0;
        const heightB = boxB.y1 - boxB.y0;
        const minHeight = Math.min(heightA, heightB);

        if (verticalIntersection === 0) return false;

        // If the vertical intersection height is less than 65% of the height of the smaller box,
        // they are likely separate adjacent rows.
        const verticalOverlapRatio = verticalIntersection / minHeight;
        if (verticalOverlapRatio < 0.65) {
            return false;
        }

        // Calculate horizontal intersection
        const xLeft = Math.max(boxA.x0, boxB.x0);
        const xRight = Math.min(boxA.x1, boxB.x1);
        const horizontalIntersection = Math.max(0, xRight - xLeft);

        const widthA = boxA.x1 - boxA.x0;
        const widthB = boxB.x1 - boxB.x0;
        const minWidth = Math.min(widthA, widthB);

        if (horizontalIntersection === 0) return false;

        // If they overlap horizontally by more than 50% of the smaller box's width,
        // one is nested inside the other or they represent the same line.
        const horizontalOverlapRatio = horizontalIntersection / minWidth;
        return horizontalOverlapRatio > 0.50;
    };

    const shouldKeepTagOver = (tagA, tagB) => {
        const rank = { 'item': 4, 'price-only': 3, 'skip': 2, 'noise': 1 };
        const rankA = rank[tagA.type] || 1;
        const rankB = rank[tagB.type] || 1;
        if (rankA !== rankB) {
            return rankA > rankB;
        }
        const areaA = tagA.bbox ? (tagA.bbox.x1 - tagA.bbox.x0) * (tagA.bbox.y1 - tagA.bbox.y0) : 0;
        const areaB = tagB.bbox ? (tagB.bbox.x1 - tagB.bbox.x0) * (tagB.bbox.y1 - tagB.bbox.y0) : 0;
        return areaA > areaB;
    };

    // Filter out overlapping tags
    for (let i = 0; i < tempTags.length; i++) {
        for (let j = i + 1; j < tempTags.length; j++) {
            const tagA = tempTags[i];
            const tagB = tempTags[j];
            if (tagA.ignored || tagB.ignored) continue;

            if (tagsOverlap(tagA, tagB)) {
                if (shouldKeepTagOver(tagA, tagB)) {
                    tagB.ignored = true;
                } else {
                    tagA.ignored = true;
                }
            }
        }
    }

    // ── Detect the printed receipt total ──────────────────────────────────────
    const TOTAL_LABEL_RE = /\b(total|montant|amount\s*due|amount\s*payable|grand\s*total|net\s*total|sub\s*total|balance\s*due|to\s*pay|a\s*payer|à\s*payer|ttc|t\.t\.c|toaal|totaal|gesamt|gesamtbetrag|summe|betrag|espece|espèce|especes|espèces|cash|encaissement|enlevé|montant\s*total|total\s*ttc|total\s*tva|total\s*a\s*payer)\b/i;
    let detectedTotal = null;
    const candidates = [];

    // Collect all numbers on lines matching TOTAL_LABEL_RE
    for (let idx = 0; idx < tempTags.length; idx++) {
        const tag = tempTags[idx];
        if (tag.ignored) continue;
        if (!TOTAL_LABEL_RE.test(tag.text)) continue;

        const priceRe = /(\d{1,5}[.,]|\d{1,5}\s+)(\d{2})(?=\s|$|[^0-9])/g;
        let pm;
        while ((pm = priceRe.exec(tag.text)) !== null) {
            const rawNum = (pm[1] + pm[2]).replace(/[^0-9]/g, '');
            const val = parseFloat(rawNum.slice(0, -2) + '.' + rawNum.slice(-2));
            if (!isNaN(val) && val > 0 && val < 100000) {
                candidates.push({ val, tagIdx: idx });
            }
        }
    }

    // Sort candidates by position (bottom-most first)
    candidates.sort((a, b) => b.tagIdx - a.tagIdx);

    // DP subset sum to find largest subset matching a candidate exactly
    function findBestSubset(items, target) {
        const targetCents = Math.round(target * 100);
        const itemCents = items.map(i => Math.round(i.parsedPrice * 100));
        const N = items.length;

        // Safety bound: target up to 10,000.00
        if (targetCents > 1000000 || targetCents <= 0 || N === 0) return null;

        const dp = new Int32Array(targetCents + 1).fill(-1);
        dp[0] = 0;
        const choices = Array.from({ length: N }, () => new Uint8Array(targetCents + 1));

        for (let i = 0; i < N; i++) {
            const coin = itemCents[i];
            if (coin <= 0) continue;
            for (let w = targetCents; w >= coin; w--) {
                if (dp[w - coin] !== -1) {
                    if (dp[w - coin] + 1 > dp[w]) {
                        dp[w] = dp[w - coin] + 1;
                        choices[i][w] = 1;
                    }
                }
            }
        }

        if (dp[targetCents] === -1) return null;

        const subset = new Set();
        let w = targetCents;
        for (let i = N - 1; i >= 0; i--) {
            if (choices[i][w]) {
                subset.add(i);
                w -= itemCents[i];
            }
        }
        return subset;
    }

    let bestSubsetResult = null;

    // 1. Try to find a candidate that equals a subset sum of PREVIOUS items
    for (const cand of candidates) {
        // Only consider items parsed BEFORE this candidate's line
        const validItemTags = tempTags.filter((t, i) => i < cand.tagIdx && t.type === 'item' && !t.ignored && t.parsedPrice > 0);

        const subset = findBestSubset(validItemTags, cand.val);
        if (subset) {
            detectedTotal = cand.val;
            bestSubsetResult = { validItemTags, subset, candTagIdx: cand.tagIdx };
            break; // found the bottom-most total that matches a subset of previous items!
        }
    }

    // 2. Fallback: if no subset sums match, just take the bottom-most candidate
    if (detectedTotal === null && candidates.length > 0) {
        detectedTotal = candidates[0].val;
    }

    // 3. Ignore pertinent filter: if we found a valid subset, ignore other items
    if (bestSubsetResult) {
        // Ignore items before the total that aren't in the subset
        for (let i = 0; i < bestSubsetResult.validItemTags.length; i++) {
            if (!bestSubsetResult.subset.has(i)) {
                bestSubsetResult.validItemTags[i].ignored = true;
            }
        }
        // Also ignore any items that appear AFTER the accepted total
        for (let i = bestSubsetResult.candTagIdx + 1; i < tempTags.length; i++) {
            if (tempTags[i].type === 'item') {
                tempTags[i].ignored = true;
            }
        }
    }

    // Build the final items list and taggedLines
    const taggedLines = [];
    const items = [];

    for (const tag of tempTags) {
        if (tag.ignored) continue;

        if (tag.type === 'item' && tag.parsedItem) {
            tag.parsedItem._ocrIdx = taggedLines.length; // link correct index
            items.push(tag.parsedItem);
        }
        taggedLines.push(tag);
    }

    return { parsed: items, taggedLines, detectedTotal };
}

// Canvas state for OCR map
let _ocrMapImg = null;

// Review canvas state (view-1) — uniform scale (image always square-scaled)
let _reviewCanvasScale = 1;

// Only stroke colors are used in the canvas overlay
const OCR_COLORS = {
    item: '#10b981'
};





// ─── ITEM MANAGEMENT ──────────────────────────────────────────────────────────

let _itemIdCounter = 1;
function makeItem(name, price) {
    return { id: 'item_' + (_itemIdCounter++), name, price, disabled: false };
}

function addItem() {
    state.items.push(makeItem('', 0));
    renderItems();
    // Focus the new name input
    setTimeout(() => {
        const inputs = document.querySelectorAll('.item-name-input');
        if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
}


function toggleItemDisabled(id) {
    const item = state.items.find(i => i.id === id);
    if (item) {
        item.disabled = !item.disabled;
        renderItems();
        updateTotals();
    }
}

function renderItems() {
    const hasActiveOCR = _ocrMapImg && state._ocrTaggedLines && state._ocrTaggedLines.length > 0 && state.items.some(i => i._ocrIdx != null && !i.disabled);
    if (hasActiveOCR) {
        renderItemsSplit();
    } else {
        renderItemsPlain();
    }

    updatePeopleButton();
}

function renderItemsPlain() {
    document.getElementById('reviewSplitPanel').classList.add('hidden');
    document.getElementById('reviewPlainPanel').classList.remove('hidden');
    const list = document.getElementById('itemsList');
    if (state.items.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="emoji">🍽️</div>No items yet</div>';
        updateTotals();
        return;
    }
    list.innerHTML = state.items.map(item => `
    <div class="item-row${item.disabled ? ' item-disabled' : ''}" data-id="${item.id}">
      <div>
        <div class="item-row-label">Item name</div>
        <input type="text" class="item-name-input" placeholder="e.g. Margherita Pizza"
               value="${escHtml(item.name)}" aria-label="Item name"
               data-action="onNameInput" data-id="${item.id}">
      </div>
      <div class="item-row-bottom">
        <div class="flex-1">
          <div class="item-row-label">Price</div>
          <input type="number" class="item-price-input" placeholder="0.00"
                 value="${item.price > 0 ? item.price.toFixed(2) : ''}"
                 min="0" step="0.01" aria-label="Item price"
                 data-action="onPriceInput" data-id="${item.id}">
        </div>
        <button class="btn-toggle${item.disabled ? ' disabled-state' : ''} mt-14"
                data-action="toggleItem" data-id="${item.id}" aria-label="Toggle item">${item.disabled ? '🚫' : '👁'}</button>
      </div>
    </div>
  `).join('');
    updateTotals();
}

function renderItemsSplit() {
    document.getElementById('reviewSplitPanel').classList.remove('hidden');
    document.getElementById('reviewPlainPanel').classList.add('hidden');
    const list = document.getElementById('reviewItemList');
    if (!list) return;

    if (state.items.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="emoji">🍽️</div>No items yet</div>';
        updateTotals();
        return;
    }

    list.innerHTML = state.items.map(item => {
        const ocrIdx = item._ocrIdx != null ? item._ocrIdx : -1;
        const tag = ocrIdx >= 0 ? (state._ocrTaggedLines || [])[ocrIdx] : null;
        const hasBbox = tag && tag.bbox ? '' : ' no-bbox';
        const disabledCls = item.disabled ? ' item-disabled' : '';
        return `
        <div class="review-item-row${hasBbox}${disabledCls}" data-id="${item.id}" data-ocr-idx="${ocrIdx}"
             data-hover="${ocrIdx}">
          <div class="review-item-fields">
            <div class="item-row-label">Item name</div>
            <input type="text" class="item-name-input" placeholder="e.g. Margherita Pizza"
                   value="${escHtml(item.name)}" aria-label="Item name"
                   data-action="onNameInput" data-id="${item.id}">
            <div class="review-item-row-bottom">
              <div class="flex-1">
                <div class="item-row-label">Price</div>
                <input type="number" class="item-price-input" placeholder="0.00"
                       value="${item.price > 0 ? item.price.toFixed(2) : ''}"
                       min="0" step="0.01" aria-label="Item price"
                       data-action="onPriceInput" data-id="${item.id}">
              </div>
              <button class="btn-toggle${item.disabled ? ' disabled-state' : ''} mt-14"
                      data-action="toggleItem" data-id="${item.id}" aria-label="Toggle item">${item.disabled ? '🚫' : '👁'}</button>
            </div>
          </div>
        </div>`;
    }).join('');

    // Draw the review canvas
    renderReviewCanvas(-1);
    updateTotals();
}

function renderReviewCanvas(highlightOcrIdx = -1) {
    const canvas = document.getElementById('reviewCanvas');
    const wrap = document.getElementById('reviewCanvasWrap');
    if (!canvas || !wrap || !_ocrMapImg) return;

    // Fit canvas to column width on first call
    if (canvas.width === 0 || wrap.clientWidth !== canvas.width) {
        const wrapW = wrap.clientWidth || 160;
        const scale = wrapW / _ocrMapImg.naturalWidth;
        canvas.width = wrapW;
        canvas.height = Math.round(_ocrMapImg.naturalHeight * scale);
        _reviewCanvasScale = scale;
    }

    const ctx = canvas.getContext('2d');
    ctx.drawImage(_ocrMapImg, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    (state._ocrTaggedLines || []).forEach((tag, idx) => {
        if (tag.type !== 'item' || !tag.bbox) return;

        // Verify if the item is still present in state.items (remove border of deleted items)
        const isPresent = state.items.some(it => it._ocrIdx === idx && !it.disabled);
        if (!isPresent) return;

        const isHL = idx === highlightOcrIdx;
        const strokeColor = OCR_COLORS.item;
        const { x0, y0, x1, y1 } = tag.bbox;
        const rx = Math.round(x0 * _reviewCanvasScale) - 2;
        const ry = Math.round(y0 * _reviewCanvasScale) - 2;
        const rw = Math.round((x1 - x0) * _reviewCanvasScale) + 4;
        const rh = Math.round((y1 - y0) * _reviewCanvasScale) + 4;

        // Border only — faint fill on highlight (violet when highlighted, else green)
        if (isHL) {
            ctx.fillStyle = 'rgba(124, 58, 237, 0.12)';
            ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, 4); ctx.fill();
        }
        ctx.strokeStyle = isHL ? '#7c3aed' : strokeColor;
        ctx.lineWidth = isHL ? 2.5 : 1.5;
        ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, 4); ctx.stroke();

        // Note: Number badges are removed as requested.

        if (isHL) {
            // Scroll the sticky canvas so the bbox is visible
            const displayScale = wrap.clientWidth / canvas.width;
            const dispY = ry * displayScale;
            wrap.scrollTo({ top: Math.max(0, dispY - wrap.clientHeight * 0.35), behavior: 'smooth' });
        }
    });
}

function reviewRowHover(ocrIdx) {
    document.querySelectorAll('.review-item-row').forEach(r => {
        r.classList.toggle('hovered', parseInt(r.dataset.ocrIdx) === ocrIdx);
    });
    renderReviewCanvas(ocrIdx);
}

function reviewRowHoverEnd() {
    document.querySelectorAll('.review-item-row').forEach(r => r.classList.remove('hovered'));
    renderReviewCanvas(-1);
}


function onNameInput(input, itemId) {
    // Update state in-place without re-rendering (preserves focus)
    const item = state.items.find(i => i.id === itemId);
    if (item) item.name = input.value;
}

function onPriceInput(input, itemId) {
    const item = state.items.find(i => i.id === itemId);
    if (item) item.price = parseFloat(input.value) || 0;
    updateTotals();
}


// ─── TIP ──────────────────────────────────────────────────────────────────────

function setTipPct(pct) {
    const subtotal = getSubtotal();
    state.tip = +(subtotal * pct / 100).toFixed(2);
    document.getElementById('tipAmount').value = state.tip > 0 ? state.tip.toFixed(2) : '';
    // Highlight active button
    [0, 5, 10, 15, 20, 25].forEach(p => {
        document.getElementById(`tip${p}`).classList.toggle('active', p === pct);
    });
    updateTotals();
}

function onTipInput() {
    state.tip = parseFloat(document.getElementById('tipAmount').value) || 0;
    // Clear pct button highlights
    [0, 5, 10, 15, 20, 25].forEach(p => document.getElementById(`tip${p}`)?.classList.remove('active'));
    updateTotals();
}

function onReceiptTotalInput() {
    const val = parseFloat(document.getElementById('receiptTotalInput').value);
    state.receiptTotal = isNaN(val) ? null : val;
    updateTotals();
}

function copyTotalToReceipt() {
    const sub = getSubtotal();
    state.receiptTotal = sub;
    const rtInput = document.getElementById('receiptTotalInput');
    if (rtInput) rtInput.value = sub.toFixed(2);
    updateTotals();
}

function getSubtotal() {
    return state.items.filter(i => !i.disabled).reduce((s, i) => s + (i.price || 0), 0);
}


function getAssignedSubtotal() {
    // Sum of prices of items that have at least one person assigned (tip excluded).
    // Each assigned item's shares sum to its full price regardless of split count.
    return state.items
        .filter(i => !i.disabled && (state.assignments[i.id] || []).length > 0)
        .reduce((s, i) => s + (i.price || 0), 0);
}

function updateTotals() {
    const sub = getSubtotal();
    const tip = state.tip || 0;

    // Bottom bar of view-1
    const totEl = document.getElementById('totalDisplay');
    if (totEl) totEl.textContent = fmtPrice(sub + tip);

    // Update persistent totals bar — Receipt Total is always items subtotal (tip excluded)
    const ptReceiptTotal = document.getElementById('ptReceiptTotal');
    const ptAssigned = document.getElementById('ptAssigned');
    const ptMidLabel = document.getElementById('ptMidLabel');
    const ptDiff = document.getElementById('ptDiff');

    if (ptReceiptTotal) ptReceiptTotal.textContent = fmtPrice(sub);

    // Steps 0-1 (Views 0 and 1): compare items total vs printed receipt total
    // Steps 2+  (Views 2+): compare items total vs assigned items total
    if (currentView < 2) {
        if (ptMidLabel) ptMidLabel.textContent = 'Receipt Total';
        const displayedReceiptTotal = state.receiptTotal ?? sub;
        if (ptAssigned) ptAssigned.textContent = fmtPrice(displayedReceiptTotal);
        const diff = sub - displayedReceiptTotal;
        if (ptDiff) {
            ptDiff.textContent = Math.abs(diff) < 0.01 ? fmtPrice(0) : (diff >= 0 ? '+' : '-') + fmtPrice(Math.abs(diff));
            ptDiff.classList.toggle('pt-diff--ok', Math.abs(diff) < 0.01);
            ptDiff.classList.toggle('pt-diff--warn', Math.abs(diff) >= 0.01);
        }
    } else {
        if (ptMidLabel) ptMidLabel.textContent = 'Assigned';
        const assigned = getAssignedSubtotal();
        const diff = sub - assigned;
        if (ptAssigned) ptAssigned.textContent = fmtPrice(assigned);
        if (ptDiff) {
            ptDiff.textContent = Math.abs(diff) < 0.01 ? fmtPrice(0) : (diff >= 0 ? '+' : '-') + fmtPrice(Math.abs(diff));
            ptDiff.classList.toggle('pt-diff--ok', Math.abs(diff) < 0.01);
            ptDiff.classList.toggle('pt-diff--warn', Math.abs(diff) >= 0.01);
        }
    }

    updatePeopleButton();

}

// ─── PEOPLE ───────────────────────────────────────────────────────────────────

let _personIdCounter = 1;
function makePerson(name) {
    return { id: 'person_' + (_personIdCounter++), name };
}

const AVATAR_COLORS = 8;
function personColor(idx) { return `color-${idx % AVATAR_COLORS}`; }
function personInitial(name) { return name.charAt(0).toUpperCase(); }

function addPerson() {
    const input = document.getElementById('personNameInput');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        alert('This name is already added.');
        return;
    }
    state.people.push(makePerson(name));
    input.value = '';
    input.focus();
    renderPeople();
}

function removePerson(id) {
    state.people = state.people.filter(p => p.id !== id);
    // Remove from all assignments
    for (const itemId in state.assignments) {
        state.assignments[itemId] = state.assignments[itemId].filter(pid => pid !== id);
    }
    renderPeople();
}

function renderPeople() {
    const list = document.getElementById('peopleList');
    const btnToAssign = document.getElementById('btnToAssign');

    if (state.people.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="emoji">👥</div>No one added yet</div>';
        if (btnToAssign) {
            btnToAssign.disabled = true;
            btnToAssign.textContent = 'Assign → (Add someone first)';
        }
        return;
    }
    if (btnToAssign) {
        btnToAssign.disabled = false;
        btnToAssign.textContent = 'Assign →';
    }

    list.innerHTML = state.people.map((p, i) => `
    <div class="person-chip">
      <div class="person-avatar ${personColor(i)}">${personInitial(p.name)}</div>
      <span class="person-name">${escHtml(p.name)}</span>
      <button class="btn btn-danger" data-action="removePerson" data-id="${p.id}" aria-label="Remove ${escHtml(p.name)}">✕</button>
    </div>
  `).join('');

}

// goToAssign() removed — goTo(3) is called directly and goTo() already guards against 0 people.

// ─── ASSIGN ───────────────────────────────────────────────────────────────────

function toggleAssign(itemId, personId) {
    if (!state.assignments[itemId]) state.assignments[itemId] = [];
    const idx = state.assignments[itemId].indexOf(personId);
    if (idx === -1) {
        state.assignments[itemId].push(personId);
    } else {
        state.assignments[itemId].splice(idx, 1);
    }
    // Re-render just the buttons for this item
    renderAssignItem(itemId);
    renderRunningTotals();
    updateSummaryButton();
}

function splitAllEqually() {
    state.items.filter(i => !i.disabled).forEach(item => {
        state.assignments[item.id] = state.people.map(p => p.id);
    });
    renderAssign();
    renderRunningTotals();
    updateSummaryButton();
}

function resetAssignments() {
    state.items.forEach(item => {
        state.assignments[item.id] = [];
    });
    renderAssign();
    renderRunningTotals();
    updateSummaryButton();
}

function renderAssign() {
    const list = document.getElementById('assignList');
    const activeItems = state.items.filter(i => !i.disabled);
    if (activeItems.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="emoji">🍽️</div>No items to assign</div>';
        return;
    }
    list.innerHTML = activeItems.map(item => `
    <div class="assign-item-card" id="assign-card-${item.id}">
      <div class="assign-item-header">
        <span class="assign-item-name">${escHtml(item.name || 'Unnamed item')}</span>
        <span class="assign-item-price">${fmtPrice(item.price)}</span>
      </div>
      <div class="assign-people" id="assign-people-${item.id}">
        ${renderAssignPeopleHTML(item.id)}
      </div>
    </div>
  `).join('');
    updateSummaryButton();
}


function renderAssignItem(itemId) {
    const container = document.getElementById(`assign-people-${itemId}`);
    if (container) container.innerHTML = renderAssignPeopleHTML(itemId);
}

function renderAssignPeopleHTML(itemId) {
    const assigned = state.assignments[itemId] || [];
    return state.people.map((p, i) => {
        const sel = assigned.includes(p.id);
        return `
      <button class="assign-person-btn ${sel ? 'selected' : ''}"
              data-action="toggleAssign" data-item="${itemId}" data-person="${p.id}"
              aria-pressed="${sel}"
              aria-label="${escHtml(p.name)}">
        <span class="person-avatar ${personColor(i)} avatar-sm">
          ${personInitial(p.name)}
        </span>
        ${escHtml(p.name)}
        ${sel ? '<span class="check">✓</span>' : ''}
      </button>
    `;
    }).join('');
}

function updateSummaryButton() {
    const hasUnassigned = state.items.filter(i => !i.disabled).some(item => {
        const a = state.assignments[item.id];
        return !a || a.length === 0;
    });
    const btn = document.getElementById('btnToSummary');
    if (btn) {
        btn.disabled = hasUnassigned;
        btn.textContent = hasUnassigned ? 'Summary → (Assign all items first)' : 'Summary →';
    }

}

// ─── RUNNING TOTALS ───────────────────────────────────────────────────────────

function renderRunningTotals() {
    updateTotals(); // keep persistent bar in sync
    const totals = computePersonTotals();
    const container = document.getElementById('runningTotals');
    if (state.people.length === 0) { container.innerHTML = ''; return; }

    container.innerHTML = state.people.map((p, i) => {
        const t = totals[p.id] || 0;
        return `
      <div class="running-total-chip">
        <span class="rt-name">${escHtml(p.name)}</span>
        <span class="rt-amount">${fmtPrice(t)}</span>
      </div>
    `;
    }).join('');
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────

function computePersonTotals() {
    // For each item, split cost equally among assigned people.
    // Tip is distributed proportionally to each person's subtotal.
    const subtotals = {}; // personId -> subtotal before tip
    state.people.forEach(p => { subtotals[p.id] = 0; });

    state.items.filter(i => !i.disabled).forEach(item => {
        const assigned = state.assignments[item.id] || [];
        if (assigned.length === 0) return;
        const share = (item.price || 0) / assigned.length;
        assigned.forEach(pid => { subtotals[pid] = (subtotals[pid] || 0) + share; });
    });

    // Distribute tip proportionally
    const totalSubtotal = Object.values(subtotals).reduce((a, b) => a + b, 0);
    const totals = {};
    state.people.forEach(p => {
        const sub = subtotals[p.id] || 0;
        const tipShare = totalSubtotal > 0 ? (sub / totalSubtotal) * (state.tip || 0) : 0;
        totals[p.id] = sub + tipShare;
    });

    return totals;
}

function computePersonItems() {
    // Returns { personId: [{item, share, splitCount}] }
    const result = {};
    state.people.forEach(p => { result[p.id] = []; });

    state.items.filter(i => !i.disabled).forEach(item => {
        const assigned = state.assignments[item.id] || [];
        if (assigned.length === 0) return;
        const share = (item.price || 0) / assigned.length;
        assigned.forEach(pid => {
            if (result[pid]) {
                result[pid].push({ item, share, splitCount: assigned.length });
            }
        });
    });
    return result;
}

function renderSummary() {
    const totals = computePersonTotals();
    const personItems = computePersonItems();
    // Grand Total = sum of what everyone actually owes (assigned items + proportional tip).
    // Using computePersonTotals() ensures unassigned items are NOT counted.
    const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

    let html = `
    <div class="grand-total-card">
      <div class="grand-total-label">Grand Total</div>
      <div class="grand-total-amount">${fmtPrice(grandTotal)}</div>
      ${state.tip > 0 ? `<div class="text-sub-hint">incl. ${fmtPrice(state.tip)} tip</div>` : ''}
    </div>
  `;

    state.people.forEach((p, i) => {
        const items = personItems[p.id] || [];
        const total = totals[p.id] || 0;
        // tipShare = person's total minus their item shares (= their proportional cut of the tip)
        const itemsSubtotal = items.reduce((s, x) => s + x.share, 0);
        const tipShare = total - itemsSubtotal;

        html += `
      <div class="summary-person-card">
        <div class="summary-person-header">
          <div class="person-avatar ${personColor(i)}">${personInitial(p.name)}</div>
          <span class="summary-person-name">${escHtml(p.name)}</span>
          <span class="summary-person-total">${fmtPrice(total)}</span>
        </div>
        ${items.length === 0 ? '<div class="text-empty">No items assigned</div>' : ''}
        ${items.map(({ item, share, splitCount }) => `
          <div class="summary-item-line">
            <span>${escHtml(item.name || 'Unnamed')}${splitCount > 1 ? `<span class="split-note">÷${splitCount}</span>` : ''}</span>
            <span>${fmtPrice(share)}</span>
          </div>
        `).join('')}
        ${state.tip > 0 && tipShare > 0.001 ? `
          <div class="summary-item-line text-italic">
            <span>Tip (proportional)</span>
            <span>${fmtPrice(tipShare)}</span>
          </div>
        ` : ''}
      </div>
    `;
    });

    document.getElementById('summaryContent').innerHTML = html;
}






// ─── MISC ─────────────────────────────────────────────────────────────────────

function renderAll() {
    renderItems();
    renderPeople();
    // Restore tip
    if (state.tip > 0) {
        const tipEl = document.getElementById('tipAmount');
        if (tipEl) tipEl.value = state.tip.toFixed(2);

        const sub = getSubtotal();
        if (sub > 0) {
            const pct = Math.round((state.tip / sub) * 100);
            if ([0, 5, 10, 15, 20, 25].includes(pct)) {
                document.getElementById(`tip${pct}`)?.classList.add('active');
            }
        }
    }
    // Restore user-entered receipt total
    const rtInput = document.getElementById('receiptTotalInput');
    if (rtInput && state.receiptTotal != null) {
        rtInput.value = state.receiptTotal.toFixed(2);
    }
    updateTotals();
}

function startOver() {
    if (!confirm('Start a new receipt? This will clear everything.')) return;
    state = {
        items: [], people: [], assignments: {}, tip: 0, receiptTotal: null,
        _ocrRaw: null, _ocrLines: [], _ocrTaggedLines: []
    };

    // Clear file input and preview image
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    const previewImg = document.getElementById('previewImg');
    if (previewImg) { previewImg.src = ''; previewImg.classList.remove('visible'); }
    // Restore upload zone visibility
    const uploadZone = document.getElementById('uploadZone');
    if (uploadZone) uploadZone.classList.remove('hidden');
    const manualEntryRow = document.getElementById('manualEntryRow');
    if (manualEntryRow) manualEntryRow.classList.remove('hidden');

    // Hide scan button
    const btnScanEl = document.getElementById('btnScan');
    if (btnScanEl) btnScanEl.classList.add('hidden');
    // Reset OCR canvas
    window._receiptFile = null;
    _ocrMapImg = null;
    _reviewCanvasScale = 1;
    // Clear tip UI
    const tipAmountEl = document.getElementById('tipAmount');
    if (tipAmountEl) tipAmountEl.value = '';
    [0, 5, 10, 15, 20, 25].forEach(p => document.getElementById(`tip${p}`)?.classList.remove('active'));
    // Clear receipt total UI
    const receiptTotalEl = document.getElementById('receiptTotalInput');
    if (receiptTotalEl) receiptTotalEl.value = '';
    goTo(0);
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtPrice(val) {
    return (parseFloat(val) || 0).toFixed(2);
}
