const https = require("https");
const fs = require("fs");

const APIs = [
    {
        name: "Basic API",
        baseUrl:
            "https://catalog.roproxy.com/v1/search/items/details?Category=12&Subcategory=39&Limit=30",
    },
    {
        name: "Latest API",
        baseUrl:
            "https://catalog.roproxy.com/v1/search/items/details?Category=12&Subcategory=39&Limit=30&salesTypeFilter=1&SortType=3",
    },
];

const EXISTING_FILE = "EmoteSniper.json";
const THUMBNAIL_API =
    "https://thumbnails.roblox.com/v1/assets?assetIds={id}&size=420x420&format=Png&isCircular=false";

const CONCURRENT_REQUESTS = 1;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function loadExistingData() {
    try {
        if (fs.existsSync(EXISTING_FILE)) {
            const data = JSON.parse(fs.readFileSync(EXISTING_FILE, "utf8"));
            return { items: data.data || [], ids: new Set((data.data || []).map(item => item.id)) };
        }
    } catch (error) {
        log(`File read error: ${error.message}`);
    }
    return { items: [], ids: new Set() };
}

async function makeRequest(url, timeout = 10000) {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
                
                https.get(url, (res) => {
                    clearTimeout(timer);
                    let data = "";
                    
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    
                    res.on("data", chunk => data += chunk);
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            reject(new Error("JSON parse failed"));
                        }
                    });
                    res.on("error", reject);
                }).on("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
            });
        } catch (error) {
            if (attempt % 10 === 0) {
                log(`Request failing ${attempt} times: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}

async function checkAssetValidity(assetId) {
    try {
        const data = await makeRequest(THUMBNAIL_API.replace("{id}", assetId));
        if (data.data && data.data[0]) {
            const state = data.data[0].state;
            return {
                valid: state === "Completed",
                blocked: state === "Blocked"
            };
        }
    } catch {}
    return { valid: false, blocked: false };
}

async function checkMultipleAssets(assetIds) {
    const results = new Map();
    log(`Checking ${assetIds.length} assets...`);
    
    for (let i = 0; i < assetIds.length; i += CONCURRENT_REQUESTS) {
        const batch = assetIds.slice(i, i + CONCURRENT_REQUESTS);
        const promises = batch.map(async id => ({ id, result: await checkAssetValidity(id) }));
        
        try {
            const batchResults = await Promise.all(promises);
            batchResults.forEach(({ id, result }) => results.set(id, result));
            log(`Checked ${Math.min(i + CONCURRENT_REQUESTS, assetIds.length)}/${assetIds.length} assets`);
        } catch (error) {
            log(`Batch failed, retrying individually...`);
            // إعادة محاولة فردية للعناصر الفاشلة
            for (const id of batch) {
                if (!results.has(id)) {
                    results.set(id, await checkAssetValidity(id));
                }
            }
        }
    }
    
    return results;
}

async function fetchAllPages(baseUrl, apiName) {
    const items = [];
    let cursor = "";
    let pageCount = 0;
    
    log(`Starting ${apiName}...`);
    
    while (true) {
        try {
            pageCount++;
            const url = `${baseUrl}${cursor ? `&Cursor=${cursor}` : ""}`;
            const response = await makeRequest(url, 15000);
            
            if (response.data && Array.isArray(response.data)) {
                items.push(...response.data);
                log(`${apiName} page ${pageCount}: +${response.data.length} items (total: ${items.length})`);
            }
            
            if (!response.nextPageCursor || response.nextPageCursor.trim() === "") {
                break;
            }
            
            cursor = response.nextPageCursor;
        } catch (error) {
            log(`${apiName} page ${pageCount} failed: ${error.message}`);
            break;
        }
    }
    
    log(`${apiName} completed: ${items.length} items`);
    return items;
}

async function fetchFromAllAPIs(globalIds, allValidItems) {
    const apiPromises = APIs.map(async (api) => {
        const items = await fetchAllPages(api.baseUrl, api.name);
        return { name: api.name, items };
    });
    
    const results = await Promise.all(apiPromises);
    let newItems = [];
    
    results.forEach(({ name, items }) => {
        items.forEach(item => {
            if (!globalIds.has(item.id)) {
                newItems.push(item);
                globalIds.add(item.id);
            }
        });
    });
    
    if (newItems.length === 0) {
        return { newValid: 0, invalid: 0, blocked: 0 };
    }
    
    const validationResults = await checkMultipleAssets(newItems.map(item => item.id));
    let newValid = 0, invalid = 0, blocked = 0;
    
    newItems.forEach(item => {
        const result = validationResults.get(item.id);
        if (result?.valid) {
            allValidItems.push({ id: item.id, name: item.name });
            newValid++;
        } else if (result?.blocked) {
            blocked++;
        } else {
            invalid++;
        }
    });
    
    return { newValid, invalid, blocked };
}

async function checkForRemovedItems(existingItems) {
    if (existingItems.length === 0) {
        return { validItems: [], removedCount: 0 };
    }
    
    const validationResults = await checkMultipleAssets(existingItems.map(item => item.id));
    const validItems = [];
    let removedCount = 0;
    
    existingItems.forEach(item => {
        if (validationResults.get(item.id)?.blocked) {
            removedCount++;
        } else {
            validItems.push(item);
        }
    });
    
    return { validItems, removedCount };
}

function saveData(items) {
    try {
        const output = {
            keyword: null,
            totalItems: items.length,
            lastUpdate: new Date().toISOString(),
            data: items,
        };
        fs.writeFileSync(EXISTING_FILE, JSON.stringify(output, null, 2));
        return true;
    } catch (error) {
        log(`Save failed: ${error.message}`);
        return false;
    }
}

async function runOnce() {
    const startTime = Date.now();
    log("Starting EmoteSniper...");
    
    try {
        log("Loading existing data...");
        const existing = loadExistingData();
        log(`Found ${existing.items.length} existing items`);
        
        log("Checking for removed items...");
        const { validItems, removedCount } = await checkForRemovedItems(existing.items);
        log(`Removed ${removedCount} blocked items, ${validItems.length} remain`);
        
        const globalIds = new Set(validItems.map(item => item.id));
        const allValidItems = [...validItems];
        
        log("Fetching from APIs...");
        const stats = await fetchFromAllAPIs(globalIds, allValidItems);
        
        log("Saving data...");
        saveData(allValidItems);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        log(`COMPLETE: ${allValidItems.length} total | +${stats.newValid} new | -${removedCount} removed | ${duration}s`);
        
        process.exit(0);
    } catch (error) {
        log(`FATAL ERROR: ${error.message}`);
        process.exit(1);
    }
}

runOnce();
