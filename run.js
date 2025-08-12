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

async function fetchFromAllAPIs(globalIds, allItems) {
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

        items.forEach((item) => {
            if (globalIds.has(item.id)) {
                duplicateCount++;
            } else {
                newItems.push(item);
                globalIds.add(item.id);
            }
        });
    });

    allItems.push(
        ...newItems.map((item) => ({ id: item.id, name: item.name }))
    );

    return {
        newItems: newItems.length,
        duplicate: duplicateCount,
    };
}

function saveData(items) {
    const output = {
        keyword: null,
        totalItems: items.length,
        lastUpdate: new Date().toISOString(),
        data: items,
    };

    try {
        fs.writeFileSync(
            EXISTING_FILE,
            JSON.stringify(output, null, 2),
            "utf8"
        );
        return true;
    } catch (error) {
        log(`Save error: ${error.message}`);
        return false;
    }
}

async function updateEmotes() {
    const startTime = Date.now();
    log("Starting EmoteSniper update...");

    try {
        const existing = loadExistingData();
        const globalIds = new Set(existing.items.map((item) => item.id));
        const allItems = [...existing.items];

        const totalStats = await fetchFromAllAPIs(globalIds, allItems);
        const saveSuccess = saveData(allItems);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        log(
            `Update complete - Items: ${allItems.length} | New: ${totalStats.newItems} | Time: ${duration}s`
        );

        return {
            success: true,
            totalItems: allItems.length,
            newItems: totalStats.newItems,
            duration: duration,
        };
    } catch (error) {
        log(`Update error: ${error.message}`);
        return {
            success: false,
            error: error.message,
        };
    }
}

async function main() {
    log("Starting EmoteSniper single run...");
    
    try {
        const result = await updateEmotes();
        
        if (result.success) {
            log("EmoteSniper completed successfully");
            process.exit(0);
        } else {
            log(`EmoteSniper failed: ${result.error}`);
            process.exit(1);
        }
    } catch (error) {
        log(`EmoteSniper error: ${error.message}`);
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
