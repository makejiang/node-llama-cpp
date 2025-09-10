// test fs.pathExists
import * as fs from "fs-extra";
import * as path from "path";
import { fileURLToPath } from "url";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// test fs.pathExists
async function testPathExists() {
    const testPath = path.join(__dirname, "llama", "localBuilds", "win-x64-sycl-release-b5760", "llama-addon.node");

    const exists = await fs.pathExists(testPath);
    console.log(`Path ${testPath} exists: ${exists}`);
}
testPathExists();