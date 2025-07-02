import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 显示帮助信息
function showHelp() {
    console.log('SYCL 管理工具');
    console.log('='.repeat(50));
    console.log('用法:');
    console.log('  node sycl-manager.js create <zip文件名>   - 创建SYCL二进制文件');
    console.log('  node sycl-manager.js test                - 测试SYCL二进制文件兼容性');
    console.log('  node sycl-manager.js help                - 显示帮助信息');
    console.log('');
    console.log('示例:');
    console.log('  node sycl-manager.js create intel-sycl-opt.zip');
    console.log('  node sycl-manager.js test');
}

// 创建SYCL二进制文件功能
async function createSyclBins(zipFileName) {
    console.log(`开始创建SYCL二进制文件... (使用ZIP文件: ${zipFileName})`);
    
    const nodeModulesPath = path.join(__dirname, 'node_modules', '@node-llama-cpp');
    const sourcePath = path.join(nodeModulesPath, 'win-x64-cuda');
    const targetPath = path.join(nodeModulesPath, 'win-x64-sycl');
    const targetBinsPath = path.join(targetPath, 'bins');
    const oldBinsPath = path.join(targetBinsPath, 'win-x64-cuda');
    const newBinsPath = path.join(targetBinsPath, 'win-x64-sycl');
    
    try {
        // 步骤1: 复制目录 win-x64-cuda 为 win-x64-sycl
        console.log('1. 复制目录 win-x64-cuda 为 win-x64-sycl...');
        if (fs.existsSync(targetPath)) {
            console.log('   目标目录已存在，先删除...');
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        await copyDirectory(sourcePath, targetPath);
        console.log('   复制完成');

        // 步骤2: 改名目录
        console.log('2. 重命名bins目录...');
        if (fs.existsSync(oldBinsPath) && !fs.existsSync(newBinsPath)) {
            fs.renameSync(oldBinsPath, newBinsPath);
            console.log('   重命名完成');
        } else if (fs.existsSync(newBinsPath)) {
            console.log('   目标目录已存在，跳过重命名');
        } else {
            console.log('   源目录不存在，跳过重命名');
        }

        // 步骤3: 删除除了_nlcBuildMetadata.json以外的所有文件
        console.log('3. 清理bins目录...');
        if (fs.existsSync(newBinsPath)) {
            const files = fs.readdirSync(newBinsPath);
            for (const file of files) {
                if (file !== '_nlcBuildMetadata.json') {
                    const filePath = path.join(newBinsPath, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        fs.rmSync(filePath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(filePath);
                    }
                }
            }
            console.log('   清理完成');
        }

        // 步骤3.5: 修改_nlcBuildMetadata.json文件中的cuda为sycl
        console.log('3.5. 修改_nlcBuildMetadata.json文件...');
        const metadataFilePath = path.join(newBinsPath, '_nlcBuildMetadata.json');
        if (fs.existsSync(metadataFilePath)) {
            let content = fs.readFileSync(metadataFilePath, 'utf8');
            const originalContent = content;
            content = content.replace(/cuda/g, 'sycl');
            if (content !== originalContent) {
                fs.writeFileSync(metadataFilePath, content, 'utf8');
                console.log('   _nlcBuildMetadata.json文件已更新');
            } else {
                console.log('   _nlcBuildMetadata.json文件无需更新');
            }
        } else {
            console.log('   _nlcBuildMetadata.json文件不存在，跳过修改');
        }

        // 步骤4: 检查ZIP文件是否存在
        const zipFilePath = path.join(__dirname, zipFileName);
        console.log('4. 检查ZIP文件...');
        
        if (!fs.existsSync(zipFilePath)) {
            throw new Error(`ZIP文件不存在: ${zipFilePath}\n请手动下载文件并放置到脚本所在目录`);
        }
        console.log('   ZIP文件已找到');

        // 步骤5: 解压ZIP文件
        console.log('5. 解压ZIP文件...');
        await extractZip(zipFilePath, newBinsPath);
        console.log('   解压完成');

        console.log('\n所有操作完成！');
        console.log(`SYCL二进制文件已安装到: ${newBinsPath}`);
        console.log(`请运行命令: node sycl-manager.js test 测试SYCL兼容性`);
        
        return true;
    } catch (error) {
        console.error('操作失败:', error.message);
        return false;
    }
}

// 测试SYCL二进制文件兼容性功能
async function testSyclBinary() {
    const require = createRequire(import.meta.url);
    
    // 测试配置
    const BINARY_PATH = path.join(__dirname, "node_modules", "@node-llama-cpp", "win-x64-sycl", "bins", "win-x64-sycl", "llama-addon.node");
    const GPU_TYPE = "sycl";

    console.log("=".repeat(80));
    console.log("SYCL Binary Direct Test");
    console.log("=".repeat(80));
    console.log(`Binary Path: ${BINARY_PATH}`);
    console.log(`GPU Type: ${GPU_TYPE}`);
    console.log("=".repeat(80));

    try {
        // 步骤1: 检查文件是否存在
        console.log("🔍 Step 1: Checking if binary file exists...");
        if (!fs.existsSync(BINARY_PATH)) {
            throw new Error(`Binary file does not exist: ${BINARY_PATH}`);
        }
        console.log("✅ Binary file exists");

        // 步骤2: 获取文件信息
        console.log("🔍 Step 2: Getting file information...");
        const stats = fs.statSync(BINARY_PATH);
        console.log(`📊 File size: ${stats.size} bytes`);
        console.log(`📅 Modified: ${stats.mtime}`);

        // 步骤3: 尝试加载二进制文件
        console.log("🔍 Step 3: Attempting to load binary...");
        let binding;
        try {
            binding = require(BINARY_PATH);
            console.log("✅ Successfully loaded binary");
        } catch (loadError) {
            console.error("❌ Failed to load binary:", loadError);
            console.error("❌ Error details:");
            console.error("  - Message:", loadError.message);
            console.error("  - Code:", loadError.code);
            console.error("  - Errno:", loadError.errno);
            console.error("  - Syscall:", loadError.syscall);
            console.error("  - Path:", loadError.path);
            
            if (loadError.message.includes('DLL')) {
                console.error("💡 This appears to be a DLL loading issue");
                console.error("💡 Possible causes:");
                console.error("   - Missing SYCL runtime dependencies");
                console.error("   - Missing Intel oneAPI runtime");
                console.error("   - Missing Visual C++ redistributables");
                console.error("   - Incompatible architecture (x64 vs x86)");
                console.error("   - Missing GPU drivers");
            }
            throw loadError;
        }

        // 步骤4: 检查绑定模块的基本功能
        console.log("🔍 Step 4: Checking binding module functions...");
        const availableFunctions = Object.getOwnPropertyNames(binding).filter(name => typeof binding[name] === 'function');
        console.log("🔧 Available functions:", availableFunctions);

        // 检查必需的函数
        const requiredFunctions = ['loadBackends', 'getGpuType', 'init', 'getGpuVramInfo', 'getGpuDeviceInfo', 'ensureGpuDeviceIsSupported'];
        const missingFunctions = requiredFunctions.filter(func => typeof binding[func] !== 'function');
        
        if (missingFunctions.length > 0) {
            console.error("❌ Missing required functions:", missingFunctions);
            throw new Error(`Missing required functions: ${missingFunctions.join(', ')}`);
        }
        console.log("✅ All required functions are available");

        // 步骤5: 设置日志级别
        console.log("🔍 Step 5: Setting log level...");
        if (typeof binding.setLoggerLogLevel === 'function') {
            binding.setLoggerLogLevel(2); // Error level
            console.log("✅ Log level set to error");
        } else {
            console.log("⚠️  setLoggerLogLevel function not available");
        }

        // 步骤6: 加载后端
        console.log("🔍 Step 6: Loading backends...");
        try {
            binding.loadBackends();
            const loadedGpuType = binding.getGpuType();
            console.log("✅ Backends loaded successfully");
            console.log("🎯 Detected GPU type:", loadedGpuType);
            
            // 如果检测不到SYCL，尝试重新加载
            if (loadedGpuType == null || (loadedGpuType === false && GPU_TYPE !== false)) {
                console.log("🔄 GPU type not detected, trying to reload backends with binary directory...");
                const backendDir = path.dirname(path.resolve(BINARY_PATH));
                console.log("📁 Backend directory:", backendDir);
                binding.loadBackends(backendDir);
                
                const reloadedGpuType = binding.getGpuType();
                console.log("🎯 GPU type after reload:", reloadedGpuType);
            }
        } catch (backendError) {
            console.error("❌ Failed to load backends:", backendError);
            console.error("💡 This might indicate:");
            console.error("   - SYCL runtime is not properly installed");
            console.error("   - Intel GPU drivers are missing or outdated");
            console.error("   - oneAPI runtime is not available");
            throw backendError;
        }

        // 步骤7: 初始化
        console.log("🔍 Step 7: Initializing binding...");
        try {
            await binding.init();
            console.log("✅ Binding initialized successfully");
        } catch (initError) {
            console.error("❌ Failed to initialize binding:", initError);
            console.error("💡 This might indicate:");
            console.error("   - GPU device is not available");
            console.error("   - SYCL device enumeration failed");
            console.error("   - Insufficient GPU memory");
            throw initError;
        }

        // 步骤8: 获取GPU信息
        console.log("🔍 Step 8: Getting GPU information...");
        try {
            const vramInfo = binding.getGpuVramInfo();
            console.log("💾 VRAM info:", vramInfo);
            
            const deviceInfo = binding.getGpuDeviceInfo();
            console.log("🔧 Device info:", deviceInfo);
        } catch (infoError) {
            console.error("❌ Failed to get GPU info:", infoError);
            console.error("💡 This might indicate GPU communication issues");
            throw infoError;
        }

        // 步骤9: 验证GPU类型
        console.log("🔍 Step 9: Validating GPU type...");
        const finalGpuType = binding.getGpuType();
        console.log("🎯 Final GPU type:", finalGpuType);
        
        if (finalGpuType !== GPU_TYPE) {
            const errorMsg = `GPU type mismatch. Expected: ${GPU_TYPE}, got: ${finalGpuType}`;
            console.error("❌", errorMsg);
            console.error("💡 This indicates the binary didn't load the expected GPU backend");
            throw new Error(errorMsg);
        }
        console.log("✅ GPU type validation passed");

        // 步骤10: 确保设备支持
        console.log("🔍 Step 10: Ensuring GPU device support...");
        try {
            binding.ensureGpuDeviceIsSupported();
            console.log("✅ GPU device is supported");
        } catch (supportError) {
            console.error("❌ GPU device is not supported:", supportError);
            console.error("💡 This might indicate:");
            console.error("   - Your GPU is not compatible with SYCL");
            console.error("   - GPU drivers need to be updated");
            console.error("   - SYCL runtime configuration issues");
            throw supportError;
        }

        console.log("🎉 All tests passed! SYCL binary is compatible.");
        return true;

    } catch (error) {
        console.error("💥 Test failed:", error.message);
        return false;
    }
}

// 复制目录函数
async function copyDirectory(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`源目录不存在: ${source}`);
    }
    
    // 创建目标目录
    fs.mkdirSync(destination, { recursive: true });
    
    const files = fs.readdirSync(source);
    
    for (const file of files) {
        const sourcePath = path.join(source, file);
        const destPath = path.join(destination, file);
        const stat = fs.statSync(sourcePath);
        
        if (stat.isDirectory()) {
            await copyDirectory(sourcePath, destPath);
        } else {
            fs.copyFileSync(sourcePath, destPath);
        }
    }
}

// 解压ZIP文件函数 (使用Windows内置的PowerShell命令)
function extractZip(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
        try {
            // 确保目标目录存在
            fs.mkdirSync(extractPath, { recursive: true });
            
            // 使用PowerShell解压
            const command = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`;
            
            console.log('   正在解压...');
            execSync(command, { stdio: 'inherit' });
            resolve();
        } catch (error) {
            reject(new Error(`解压失败: ${error.message}`));
        }
    });
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        showHelp();
        process.exit(1);
    }
    
    const command = args[0].toLowerCase();
    
    try {
        switch (command) {
            case 'create':
                if (args.length < 2) {
                    console.error('错误: 请提供ZIP文件名作为参数');
                    console.error('用法: node sycl-manager.js create <zip文件名>');
                    console.error('示例: node sycl-manager.js create intel-sycl-opt.zip');
                    process.exit(1);
                }
                const zipFileName = args[1];
                const createSuccess = await createSyclBins(zipFileName);
                process.exit(createSuccess ? 0 : 1);
                break;
                
            case 'test':
                console.log("开始测试SYCL二进制文件兼容性...");
                const testSuccess = await testSyclBinary();
                console.log("=".repeat(80));
                if (testSuccess) {
                    console.log("🎉 SYCL BINARY COMPATIBILITY TEST PASSED!");
                    console.log("✅ The binary should work with your system");
                } else {
                    console.log("❌ SYCL BINARY COMPATIBILITY TEST FAILED!");
                    console.log("❌ The binary is not compatible with your system");
                }
                console.log("=".repeat(80));
                process.exit(testSuccess ? 0 : 1);
                break;
                
            case 'help':
            case '--help':
            case '-h':
                showHelp();
                process.exit(0);
                break;
                
            default:
                console.error(`错误: 未知命令 '${command}'`);
                showHelp();
                process.exit(1);
        }
    } catch (error) {
        console.log("=".repeat(80));
        console.error("💥 UNEXPECTED ERROR!");
        console.error("❌ Error:", error.message);
        console.error("❌ Stack:", error.stack);
        console.log("=".repeat(80));
        process.exit(1);
    }
}

// 运行主函数
main().catch(console.error);
