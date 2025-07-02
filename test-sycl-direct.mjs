import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);

// 测试配置
const BINARY_PATH = ".\\llama\\localBuilds\\win-x64-sycl\\Release\\llama-addon.node";
const GPU_TYPE = "sycl";

console.log("=".repeat(80));
console.log("SYCL Binary Direct Test");
console.log("=".repeat(80));
console.log(`Binary Path: ${BINARY_PATH}`);
console.log(`GPU Type: ${GPU_TYPE}`);
console.log("=".repeat(80));

async function testSyclBinaryDirect() {
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

// 运行测试
testSyclBinaryDirect()
    .then((success) => {
        console.log("=".repeat(80));
        if (success) {
            console.log("🎉 SYCL BINARY COMPATIBILITY TEST PASSED!");
            console.log("✅ The binary should work with your system");
        } else {
            console.log("❌ SYCL BINARY COMPATIBILITY TEST FAILED!");
            console.log("❌ The binary is not compatible with your system");
        }
        console.log("=".repeat(80));
        process.exit(success ? 0 : 1);
    })
    .catch((error) => {
        console.log("=".repeat(80));
        console.error("💥 UNEXPECTED ERROR!");
        console.error("❌ Error:", error.message);
        console.error("❌ Stack:", error.stack);
        console.log("=".repeat(80));
        process.exit(1);
    });
