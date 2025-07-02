#pragma once

#include <string>
#include <vector>

namespace Napi
{
    class Env;
    class Object;
}

namespace GpuInfo
{
    Napi::Object GetSyclGpuInfo(Napi::Env env);
}
