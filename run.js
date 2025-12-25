const https = require("https");
const fs = require("fs");

const APIs = [
    {
        name: "Basic API",
        baseUrl:
            "https://catalog.roproxy.com/v1/search/items/details?Category=12&Subcategory=39&Limit=30",
        outputFile: "EmoteSniper.json"
    },
    {
        name: "Latest API",
        baseUrl:
            "https://catalog.roproxy.com/v1/search/items/details?Category=12&Subcategory=39&Limit=30&salesTypeFilter=1&SortType=3",
        outputFile: "EmoteSniper.json"
    },
    {
        name: "Animation API",
        baseUrl:
            "https://catalog.roproxy.com/v1/search/items/details?Category=12&Subcategory=38&salesTypeFilter=1&Limit=30",
        outputFile: "AnimationSniper.json"
    }
];

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function loadExistingData(filename) {
    try {
        if (fs.existsSync(filename)) {
            const data = JSON.parse(fs.readFileSync(filename, "utf8"));
            const existingItems = data.data || [];
            const existingIds = new Set(existingItems.map((item) => item.id));
            return { items: existingItems, ids: existingIds };
        }
    } catch (error) {
        log(`Error reading ${filename}, starting fresh`);
    }
    return { items: [], ids: new Set() };
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

async function fetchFromAPI(apiInfo, existingData) {
    const apiItems = [];
    let nextPageCursor = null;
    let pageCount = 0;
    let newItemsCount = 0;
    let duplicateCount = 0;

    try {
        do {
            pageCount++;
            log(`${apiInfo.name} - Page ${pageCount}`);

            const response = await fetchData(apiInfo.baseUrl, nextPageCursor);

            if (response.data && Array.isArray(response.data)) {
                response.data.forEach((item) => {
                    if (existingData.ids.has(item.id)) {
                        duplicateCount++;
                    } else {
                        const itemData = {
                            id: item.id,
                            name: item.name
                        };

                        if (item.bundledItems && Array.isArray(item.bundledItems)) {
                            const bundledAssets = {};
                            let animCounter = 1;

                            item.bundledItems.forEach(bundledItem => {
                                if (bundledItem.type === "UserOutfit") return;

                                const typeKey = (animCounter++).toString();

                                if (bundledItem.id) {
                                    if (!bundledAssets[typeKey]) {
                                        bundledAssets[typeKey] = [];
                                    }
                                    bundledAssets[typeKey].push(bundledItem.id);
                                }
                            });

                            if (Object.keys(bundledAssets).length > 0) {
                                itemData.bundledItems = bundledAssets;
                            }
                        }

                        apiItems.push(itemData);
                        existingData.ids.add(item.id);
                        newItemsCount++;
                    }
                });
            }

            nextPageCursor = response.nextPageCursor;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        } while (nextPageCursor && nextPageCursor.trim() !== "");
    } catch (error) {
        log(`Error in ${apiInfo.name}: ${error.message}`);
    }

    return {
        items: apiItems,
        newItems: newItemsCount,
        duplicates: duplicateCount
    };
}

function saveData(items, filename) {
    const output = {
        keyword: null,
        totalItems: items.length,
        lastUpdate: new Date().toISOString(),
        data: items,
    };

    try {
        fs.writeFileSync(filename, JSON.stringify(output, null, 2), "utf8");
        return true;
    } catch (error) {
        log(`Save error for ${filename}: ${error.message}`);
        return false;
    }
}

async function processAPIsByFile() {
    const startTime = Date.now();
    log("Starting combined update...");

    const apisByFile = {};
    APIs.forEach(api => {
        if (!apisByFile[api.outputFile]) {
            apisByFile[api.outputFile] = [];
        }
        apisByFile[api.outputFile].push(api);
    });

    const results = {};

    for (const [filename, apis] of Object.entries(apisByFile)) {
        log(`Processing ${filename}...`);

        const existingData = loadExistingData(filename);
        const allItems = [...existingData.items];
        let totalNewItems = 0;
        let totalDuplicates = 0;

        for (const api of apis) {
            const result = await fetchFromAPI(api, existingData);
            allItems.push(...result.items);
            totalNewItems += result.newItems;
            totalDuplicates += result.duplicates;

            log(`${api.name} - New: ${result.newItems}, Duplicates: ${result.duplicates}`);
        }


        const saveSuccess = saveData(allItems, filename);

        results[filename] = {
            success: saveSuccess,
            totalItems: allItems.length,
            newItems: totalNewItems,
            duplicates: totalDuplicates
        };

        log(`${filename} - Total: ${allItems.length}, New: ${totalNewItems}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`All updates complete - Duration: ${duration}s`);

    return { results, duration };
}

async function main() {
    log("Starting Enhanced EmoteSniper with Animation support...");

    try {
        const { results, duration } = await processAPIsByFile();

        let allSuccess = true;
        for (const [filename, result] of Object.entries(results)) {
            if (!result.success) {
                allSuccess = false;
                log(`Failed to save ${filename}`);
            } else {
                log(`✓ ${filename}: ${result.totalItems} items (${result.newItems} new)`);
            }
        }

        if (allSuccess) {
            log("Enhanced EmoteSniper completed successfully");
            process.exit(0);
        } else {
            log("Enhanced EmoteSniper completed with some errors");
            process.exit(1);
        }
    } catch (error) {
        log(`Enhanced EmoteSniper error: ${error.message}`);
        process.exit(1);
    }
}

process.on("unhandledRejection", (reason) => {
    log(`Unhandled error: ${reason}`);
    process.exit(1);
});

process.on("uncaughtException", (error) => {
    log(`Uncaught exception: ${error.message}`);
    process.exit(1);
});

main();
