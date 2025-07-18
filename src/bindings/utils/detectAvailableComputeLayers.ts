import process from "process";
import path from "path";
import fs from "fs-extra";
import semver from "semver";
import { exec } from "child_process";
import { promisify } from "util";
import {getConsoleLogPrefix} from "../../utils/getConsoleLogPrefix.js";
import {BinaryPlatform, getPlatform} from "./getPlatform.js";
import {hasFileInPath} from "./hasFileInPath.js";
import {asyncSome} from "./asyncSome.js";
import {asyncEvery} from "./asyncEvery.js";



const execAsync = promisify(exec);

async function getArcGpuDeviceNames({
    platform
}: {
    platform: BinaryPlatform
}): Promise<string[]> {
    
    try {
      if (platform === "win") {
        const { stdout } = await execAsync(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WmiObject Win32_VideoController | ForEach-Object { if ($_.ConfigManagerErrorCode -eq 0 -and $_.PNPDeviceID -match 'VEN_([0-9A-F]{4}).*DEV_([0-9A-F]{4})') { 'Name: ' + $_.Name + ' VID: ' + $matches[1] + ' DeviceID: ' + $matches[2] }}"`,
          { encoding: 'utf-8' }
        );

        return stdout
          .split('\n')
          .map(line => line.trim())
          .filter(line => {
            if (line.length === 0) return false;

            const deviceId = line.match(/DeviceID: ([0-9A-F]{4})/i)?.[1]?.toUpperCase();
            //console.log('Matched DeviceID:', deviceId); // 打印 deviceId
            if (!deviceId) return false;
            const targetDeviceIds = [
              '7D55', '64A0', '7D45', '7D40',
              '7D67', '7D51', '7D41', '56A0', 
              '56A1', '56A2', '56A5', '56A6', 
              'E20B', 'E20C', 'E212', 'E211', 
              ];
            return targetDeviceIds.includes(deviceId);
          })
          .map(line => line.split(' Name: ')[1]?.split(' VID: ')[0] || line);
      }else if (platform === "linux") {
        // Use lspci command on Linux
        const { stdout } = await execAsync('lspci | grep -i "vga\\|3d\\|display"');
        
        return stdout
          .split('\n')
          .filter(line => line.trim().length > 0)
          .map(line => {
            const match = line.match(/(?:VGA compatible controller|3D controller|Display controller): (.+)/);
            return match && match[1] ? match[1].trim() : line.trim();
          })
          .filter(name => name.toLowerCase().includes('arc'));
      } else if (platform === "mac") {
        // Use system_profiler on macOS
        const { stdout } = await execAsync('system_profiler SPDisplaysDataType | grep "Chipset Model"');
        
        return stdout
          .split('\n')
          .filter(line => line.includes('Chipset Model'))
          .map(line => line.split(':')[1]?.trim())
          .filter(name => name && name.length > 0 && name.toLowerCase().includes('arc')) as string[];
      }
    } catch (error) {
      console.error(getConsoleLogPrefix() + 'Failed to get GPU device names:', error);
    }
    
    return [];
}

async function detectSyclSupport({
    platform
}: {
    platform: BinaryPlatform
}) {
  const gpuDeviceNames = await getArcGpuDeviceNames({platform});
  if (gpuDeviceNames.length > 0) {
      console.log(getConsoleLogPrefix() + `Detected Intel Arc GPU(s): ${gpuDeviceNames.join(", ")}`);
      return true;
  }
  
  console.log(getConsoleLogPrefix() + "No Intel Arc GPU detected.");
  return false;
}

export async function detectAvailableComputeLayers({
    platform = getPlatform()
}: {
    platform?: BinaryPlatform
} = {}) {
    const [
        cuda,
        vulkan,
        metal,
        sycl
    ] = await Promise.all([
        detectCudaSupport({platform}),
        detectVulkanSupport({platform}),
        detectMetalSupport({platform}),
        detectSyclSupport({platform})
    ]);

    return {
        cuda,
        vulkan,
        metal,
        sycl
    };
}

async function detectCudaSupport({
    platform
}: {
    platform: BinaryPlatform
}) {
    if (platform === "win") {
        const librarySearchPaths = (await getCudaInstallationPaths({platform}))
            .flatMap((cudaInstallationPath) => [cudaInstallationPath, path.join(cudaInstallationPath, "bin")]);
        const windir = getWindir();

        const [
            hasNvidiaDriver,
            hasCudaRuntime
        ] = await Promise.all([
            asyncSome([
                hasFileInPath("nvml.dll"),
                fs.pathExists(path.join(windir, "System32", "nvml.dll"))
            ]),
            asyncEvery([
                asyncSome([
                    hasFileInPath("cudart64_110.dll", librarySearchPaths),
                    hasFileInPath("cudart64_11.dll", librarySearchPaths),
                    hasFileInPath("cudart64_12.dll", librarySearchPaths),
                    hasFileInPath("cudart64_13.dll", librarySearchPaths) // for when the next version comes out
                ]),
                asyncSome([
                    hasFileInPath("cublas64_11.dll", librarySearchPaths),
                    hasFileInPath("cublas64_12.dll", librarySearchPaths),
                    hasFileInPath("cublas64_13.dll", librarySearchPaths) // for when the next version comes out
                ]),
                asyncSome([
                    hasFileInPath("cublasLt64_11.dll", librarySearchPaths),
                    hasFileInPath("cublasLt64_12.dll", librarySearchPaths),
                    hasFileInPath("cublasLt64_13.dll", librarySearchPaths) // for when the next version comes out
                ])
            ])
        ]);

        return {
            hasNvidiaDriver,
            hasCudaRuntime
        };
    } else if (platform === "linux") {
        const cudaLibraryPaths = await getLinuxCudaLibraryPaths();
        const librarySearchPaths = [
            process.env.LD_LIBRARY_PATH,
            process.env.CUDA_PATH,
            "/usr/lib",
            "/usr/lib64",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib/aarch64-linux-gnu",
            "/usr/lib/armv7l-linux-gnu",
            ...cudaLibraryPaths
        ];

        const [
            hasNvidiaDriver,
            hasCudaRuntime
        ] = await Promise.all([
            asyncSome([
                hasFileInPath("libnvidia-ml.so", librarySearchPaths),
                hasFileInPath("libnvidia-ml.so.1", librarySearchPaths)
            ]),
            asyncEvery([
                asyncSome([
                    hasFileInPath("libcuda.so", librarySearchPaths),
                    hasFileInPath("libcuda.so.1", librarySearchPaths)
                ]),
                asyncSome([
                    hasFileInPath("libcudart.so", librarySearchPaths),
                    hasFileInPath("libcudart.so.11", librarySearchPaths),
                    hasFileInPath("libcudart.so.12", librarySearchPaths),
                    hasFileInPath("libcudart.so.13", librarySearchPaths) // for when the next version comes out
                ]),
                asyncSome([
                    hasFileInPath("libcublas.so", librarySearchPaths),
                    hasFileInPath("libcublas.so.11", librarySearchPaths),
                    hasFileInPath("libcublas.so.12", librarySearchPaths),
                    hasFileInPath("libcublas.so.13", librarySearchPaths) // for when the next version comes out
                ]),
                asyncSome([
                    hasFileInPath("libcublasLt.so", librarySearchPaths),
                    hasFileInPath("libcublasLt.so.11", librarySearchPaths),
                    hasFileInPath("libcublasLt.so.12", librarySearchPaths),
                    hasFileInPath("libcublasLt.so.13", librarySearchPaths) // for when the next version comes out
                ])
            ])
        ]);

        return {
            hasNvidiaDriver,
            hasCudaRuntime
        };
    }

    return {
        hasNvidiaDriver: false,
        hasCudaRuntime: false
    };
}

async function detectVulkanSupport({
    platform
}: {
    platform: BinaryPlatform
}) {
    if (platform === "win") {
        const windir = getWindir();

        return await asyncSome([
            hasFileInPath("vulkan-1.dll"),
            fs.pathExists(path.join(windir, "System32", "vulkan-1.dll")),
            fs.pathExists(path.join(windir, "SysWOW64", "vulkan-1.dll"))
        ]);
    } else if (platform === "linux") {
        const librarySearchPaths = [
            process.env.LD_LIBRARY_PATH,
            "/usr/lib",
            "/usr/lib64",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib/aarch64-linux-gnu",
            "/usr/lib/armv7l-linux-gnu",
            (process.env.PREFIX != null && process.env.PREFIX?.toLowerCase()?.includes?.("termux"))
                ? `${process.env.PREFIX}/usr/lib`
                : undefined
        ];

        return await asyncSome([
            hasFileInPath("libvulkan.so", librarySearchPaths),
            hasFileInPath("libvulkan.so.1", librarySearchPaths)
        ]);
    } else if (platform === "mac") {
        return await asyncSome([
            hasFileInPath("libvulkan.dylib"),
            hasFileInPath("libvulkan.dylib.1")
        ]);
    }

    return false;
}

async function detectMetalSupport({
    platform
}: {
    platform: BinaryPlatform
}) {
    return platform === "mac";
}

async function getLinuxCudaLibraryPaths() {
    const res: string[] = [];

    try {
        for (const cudaInstallationPath of await getCudaInstallationPaths({platform: "linux"})) {
            const cudaTargetsFolder = `${cudaInstallationPath}/targets`;
            if (!(await fs.pathExists(cudaTargetsFolder)))
                continue;

            for (const cudaTargetFolderName of await fs.readdir(cudaTargetsFolder)) {
                res.push(
                    `${cudaTargetsFolder}/${cudaTargetFolderName}/lib`,
                    `${cudaTargetsFolder}/${cudaTargetFolderName}/lib/stubs`
                );
            }
        }
    } catch (err) {
        console.error(getConsoleLogPrefix() + 'Failed to search "/usr/local/" for CUDA library paths', err);
    }

    return res;
}

async function getCudaInstallationPaths({
    platform
}: {
    platform: BinaryPlatform
}) {
    if (platform === "win") {
        try {
            const programFilesPaths = await getWindowsProgramFilesPaths();

            const potentialCudaInstallationsContainerPaths = programFilesPaths
                .map((programFilesPath) => `${programFilesPath}/NVIDIA GPU Computing Toolkit/CUDA`);

            const cudaInstallationsContainerPaths = (
                await Promise.all(
                    potentialCudaInstallationsContainerPaths.map(async (potentialCudaInstallationsContainerPath) => {
                        if (await fs.pathExists(potentialCudaInstallationsContainerPath))
                            return potentialCudaInstallationsContainerPath;

                        return null;
                    })
                )
            ).filter((path): path is string => path != null);

            const potentialCudaInstallations = (
                await Promise.all(
                    cudaInstallationsContainerPaths.map(async (cudaInstallationsContainerPath) => {
                        const cudaFolderPrefix = "v";

                        return (
                            await fs.pathExists(cudaInstallationsContainerPath)
                                ? await fs.readdir(cudaInstallationsContainerPath)
                                : []
                        )
                            .filter((installationFolderName) => installationFolderName.toLowerCase()
                                .startsWith(cudaFolderPrefix))
                            .sort((a, b) => {
                                const aVersion = a.slice(cudaFolderPrefix.length);
                                const bVersion = b.slice(cudaFolderPrefix.length);

                                try {
                                    const aVersionValid = semver.valid(semver.coerce(aVersion));
                                    const bVersionValid = semver.valid(semver.coerce(bVersion));

                                    if (aVersionValid && bVersionValid)
                                        return semver.compare(aVersionValid, bVersionValid);
                                    else if (aVersionValid)
                                        return -1;
                                    else if (bVersionValid)
                                        return 1;
                                    else
                                        return 0;
                                } catch (err) {
                                    return 0;
                                }
                            })
                            .reverse()
                            .map((installationFolderName) => `${cudaInstallationsContainerPath}/${installationFolderName}`);
                    })
                )
            ).flat();

            if (process.env.CUDA_PATH != null && process.env.CUDA_PATH !== "")
                potentialCudaInstallations.unshift(process.env.CUDA_PATH);

            return (
                await Promise.all(
                    potentialCudaInstallations.map(async (cudaFolder) => {
                        if (await fs.pathExists(cudaFolder))
                            return cudaFolder;

                        return null;
                    })
                )
            ).filter((cudaFolder): cudaFolder is string => cudaFolder != null);
        } catch (err) {
            console.error(getConsoleLogPrefix() + 'Failed to search "Program Files" for CUDA installations', err);
        }

        return [];
    } else if (platform === "linux") {
        const res: string[] = [];
        try {
            const usrLocal = "/usr/local";
            const cudaFolderPrefix = "cuda-";
            const potentialCudaFolders = (
                await fs.pathExists(usrLocal)
                    ? await fs.readdir(usrLocal)
                    : []
            )
                .filter((usrLocalFolderName) => usrLocalFolderName.toLowerCase().startsWith(cudaFolderPrefix))
                .sort((a, b) => {
                    const aVersion = a.slice(cudaFolderPrefix.length);
                    const bVersion = b.slice(cudaFolderPrefix.length);

                    try {
                        const aVersionValid = semver.valid(semver.coerce(aVersion));
                        const bVersionValid = semver.valid(semver.coerce(bVersion));

                        if (aVersionValid && bVersionValid)
                            return semver.compare(aVersionValid, bVersionValid);
                        else if (aVersionValid)
                            return -1;
                        else if (bVersionValid)
                            return 1;
                        else
                            return 0;
                    } catch (err) {
                        return 0;
                    }
                })
                .reverse()
                .map((usrLocalFolderName) => `${usrLocal}/${usrLocalFolderName}`);

            potentialCudaFolders.unshift(`${usrLocal}/cuda`);

            if (process.env.CUDA_PATH != null && process.env.CUDA_PATH !== "")
                potentialCudaFolders.unshift(process.env.CUDA_PATH);

            for (const cudaFolder of potentialCudaFolders) {
                const cudaTargetsFolder = `${cudaFolder}/targets`;
                if (!(await fs.pathExists(cudaTargetsFolder)))
                    continue;

                res.push(cudaFolder);
            }
        } catch (err) {
            console.error(getConsoleLogPrefix() + 'Failed to search "/usr/local/" for CUDA installations', err);
        }

        return res;
    }

    return [];
}

export async function getCudaNvccPaths({
    platform = getPlatform()
}: {
    platform?: BinaryPlatform
} = {}) {
    const cudaInstallationPaths = await getCudaInstallationPaths({platform});

    const nvccPotentialPaths = cudaInstallationPaths
        .map((cudaInstallationPath) => {
            if (platform === "win")
                return path.join(cudaInstallationPath, "bin", "nvcc.exe");

            return path.join(cudaInstallationPath, "bin", "nvcc");
        });

    try {
        const resolvedNvccPaths = await Promise.all(
            nvccPotentialPaths.map(async (nvccPotentialPath) => {
                if (await fs.pathExists(nvccPotentialPath))
                    return nvccPotentialPath;

                return null;
            })
        );

        return resolvedNvccPaths.filter((nvccPath): nvccPath is string => nvccPath != null);
    } catch (err) {
        console.error(getConsoleLogPrefix() + `Failed to search for "nvcc${platform === "win" ? ".exe" : ""}" in CUDA installation paths`, err);
    }

    return [];
}

function getWindir() {
    return process.env.windir || process.env.WINDIR || process.env.SystemRoot || process.env.systemroot || process.env.SYSTEMROOT ||
        "C:\\Windows";
}


export async function getWindowsProgramFilesPaths() {
    const potentialPaths = await Promise.all(
        [
            process.env["ProgramFiles(Arm)"],
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
            `${process.env.SystemDrive ?? "C:"}\\Program Files (Arm)`,
            `${process.env.SystemDrive ?? "C:"}\\Program Files`,
            `${process.env.SystemDrive ?? "C:"}\\Program Files (x86)`
        ]
            .map(async (programFilesPath) => {
                if (programFilesPath == null)
                    return null;

                if (await fs.pathExists(programFilesPath))
                    return programFilesPath;

                return null;
            })
    );

    return Array.from(new Set(potentialPaths.filter((potentialPath): potentialPath is string => potentialPath != null)));
}
