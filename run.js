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

const CONCURRENT_REQUESTS = 10; 
const BATCH_DELAY = 100;

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function loadExistingData() {
    try {
        if (fs.existsSync(EXISTING_FILE)) {
            const data = JSON.parse(fs.readFileSync(EXISTING_FILE, "utf8"));
            const existingItems = data.data || [];
            const existingIds = new Set(existingItems.map((item) => item.id));
            return { items: existingItems, ids: existingIds };
        }
    } catch (error) {
        log("Error reading file, starting fresh");
    }
    return { items: [], ids: new Set() };
}

async function checkAssetValidity(assetId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                const url = THUMBNAIL_API.replace("{id}", assetId);

                const timeout = setTimeout(() => {
                    reject(new Error("Request timeout"));
                }, 8000);

                https
                    .get(url, (res) => {
                        clearTimeout(timeout);
                        let data = "";

                        res.on("data", (chunk) => {
                            data += chunk;
                        });

                        res.on("end", () => {
                            try {
                                const jsonData = JSON.parse(data);
                                if (jsonData.data && jsonData.data.length > 0) {
                                    const state = jsonData.data[0].state;
                                    if (state === "Blocked") {
                                        resolve({
                                            valid: false,
                                            blocked: true,
                                        });
                                    } else if (state === "Completed") {
                                        resolve({
                                            valid: true,
                                            blocked: false,
                                        });
                                    } else {
                                        resolve({
                                            valid: false,
                                            blocked: false,
                                        });
                                    }
                                } else {
                                    resolve({ valid: false, blocked: false });
                                }
                            } catch {
                                resolve({ valid: false, blocked: false });
                            }
                        });
                    })
                    .on("error", (error) => {
                        clearTimeout(timeout);
                        reject(error);
                    });
            });

            return result;
        } catch (error) {
            if (attempt === maxRetries) {
                return { valid: false, blocked: false };
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
}

async function checkMultipleAssets(assetIds) {
    const results = new Map();
    
    for (let i = 0; i < assetIds.length; i += CONCURRENT_REQUESTS) {
        const batch = assetIds.slice(i, i + CONCURRENT_REQUESTS);
        
        const batchPromises = batch.map(async (assetId) => {
            const result = await checkAssetValidity(assetId);
            return { assetId, result };
        });
        
        try {
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ assetId, result }) => {
                results.set(assetId, result);
            });
            
            if (i + CONCURRENT_REQUESTS < assetIds.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
            
            log(`Checked ${Math.min(i + CONCURRENT_REQUESTS, assetIds.length)}/${assetIds.length} assets`);
        } catch (error) {
            log(`Error in batch processing: ${error.message}`);
            for (const assetId of batch) {
                if (!results.has(assetId)) {
                    try {
                        const result = await checkAssetValidity(assetId);
                        results.set(assetId, result);
                    } catch (individualError) {
                        results.set(assetId, { valid: false, blocked: false });
                    }
                }
            }
        }
    }
    
    return results;
}

async function fetchData(baseUrl, cursor = "", maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const data = await new Promise((resolve, reject) => {
                const url = `${baseUrl}${cursor ? `&Cursor=${cursor}` : ""}`;

                const timeout = setTimeout(() => {
                    reject(new Error("Request timeout"));
                }, 30000);

                https
                    .get(url, (res) => {
                        clearTimeout(timeout);
                        let data = "";

                        if (res.statusCode !== 200) {
                            reject(new Error(`HTTP Error: ${res.statusCode}`));
                            return;
                        }

                        res.on("data", (chunk) => {
                            data += chunk;
                        });

                        res.on("end", () => {
                            try {
                                const jsonData = JSON.parse(data);
                                resolve(jsonData);
                            } catch (error) {
                                reject(new Error("JSON parsing error"));
                            }
                        });
                    })
                    .on("error", (error) => {
                        clearTimeout(timeout);
                        reject(error);
                    });
            });

            return data;
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function fetchFromAllAPIs(globalIds, allValidItems) {
    log("Starting parallel API fetching...");
    
    const allApiPromises = APIs.map(async (apiInfo) => {
        const apiItems = [];
        let nextPageCursor = null;
        let pageCount = 0;

        try {
            do {
                pageCount++;
                log(`${apiInfo.name} - Page ${pageCount}`);
                const response = await fetchData(apiInfo.baseUrl, nextPageCursor);

                if (response.data && Array.isArray(response.data)) {
                    apiItems.push(...response.data);
                }

                nextPageCursor = response.nextPageCursor;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            } while (nextPageCursor && nextPageCursor.trim() !== "");
        } catch (error) {
            log(`Error in ${apiInfo.name}: ${error.message}`);
        }

        return { apiName: apiInfo.name, items: apiItems };
    });

    const allApiResults = await Promise.all(allApiPromises);
    
    const newItems = [];
    let duplicateCount = 0;
    
    allApiResults.forEach(({ apiName, items }) => {
        log(`${apiName} returned ${items.length} items`);
        items.forEach(item => {
            if (globalIds.has(item.id)) {
                duplicateCount++;
            } else {
                newItems.push(item);
                globalIds.add(item.id);
            }
        });
    });

    log(`Found ${newItems.length} new items to validate, ${duplicateCount} duplicates`);

    let newValidCount = 0;
    let invalidCount = 0;
    let blockedCount = 0;

    if (newItems.length > 0) {
        const assetIds = newItems.map(item => item.id);
        const validationResults = await checkMultipleAssets(assetIds);

        newItems.forEach(item => {
            const result = validationResults.get(item.id);
            if (result && result.valid) {
                allValidItems.push({ id: item.id, name: item.name });
                newValidCount++;
            } else if (result && result.blocked) {
                blockedCount++;
            } else {
                invalidCount++;
            }
        });
    }

    return {
        newValid: newValidCount,
        duplicate: duplicateCount,
        invalid: invalidCount,
        blocked: blockedCount,
    };
}

async function checkForRemovedItems(existingItems) {
    log(`Checking ${existingItems.length} existing items for removal...`);
    
    let removedCount = 0;
    const validItems = [];

    if (existingItems.length === 0) {
        return { validItems, removedCount };
    }

    const assetIds = existingItems.map(item => item.id);
    
    const validationResults = await checkMultipleAssets(assetIds);

    existingItems.forEach(item => {
        const result = validationResults.get(item.id);
        if (result && result.blocked) {
            removedCount++;
            log(`Item removed (blocked): ${item.name} (${item.id})`);
        } else {
            validItems.push(item);
        }
    });

    log(`Removed ${removedCount} blocked items, ${validItems.length} items remain valid`);
    return { validItems, removedCount };
}

function saveData(items) {
    const output = {
        keyword: null,
        totalItems: items.length,
        lastUpdate: new Date().toISOString(),
        data: items,
    };

    try {
        fs.writeFileSync(EXISTING_FILE, JSON.stringify(output, null, 2), "utf8");
        return true;
    } catch (error) {
        log(`Save error: ${error.message}`);
        return false;
    }
}

async function runOnce() {
    const startTime = Date.now();
    log("Starting EmoteSniper update...");

    try {
        const existing = loadExistingData();

        const { validItems, removedCount } = await checkForRemovedItems(
            existing.items,
        );

        const globalIds = new Set(validItems.map((item) => item.id));
        const allValidItems = [...validItems];

        const totalStats = await fetchFromAllAPIs(globalIds, allValidItems);

        const saveSuccess = saveData(allValidItems);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        log(
            `Update complete - Items: ${allValidItems.length} | New: ${totalStats.newValid} | Removed: ${removedCount} | Time: ${duration}s`,
        );
        log(`Performance: ~${(allValidItems.length / parseFloat(duration)).toFixed(1)} items/second`);

        log("Script completed successfully.");
        return;

    } catch (error) {
        log(`Update error: ${error.message}`);
        return;
    }
}

function startScheduler() {
    runOnce();

    setInterval(() => {
        runOnce();
    }, 3600000); // كل ساعة
}

startScheduler();
