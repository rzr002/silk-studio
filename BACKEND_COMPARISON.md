# Newton / 当前 XPBD 实测对照

2026-10-15，本机 Apple M4、macOS arm64、CPU。**Newton 的真实样片计算已经跑通；本次没有据此替换产品后端。** 两项均固定点不漂移、90 帧坐标有限，但耗时、材料耦合及依赖许可都需要分别判断。

## 实际安装与运行

在项目 `.venv-backend` 创建隔离 Python 3.13.2 环境，仅从官方 PyPI 安装 `newton==1.7.0`、`warp-lang==1.18.0`、`numpy==2.5.4`。没有安装 examples、商业插件、CUDA SDK 或全局 Python 包。使用 `newton.solvers.SolverStyle3D`，并在 Warp CPU 设备实际执行。

官方安装文档确认 macOS 使用 CPU，推荐虚拟环境；本文的“跑通”来自本地运行日志，而非该支持声明。[Newton 安装文档](https://newton-physics.github.io/newton/stable/guide/installation.html)

复现命令：

```bash
python3 -m venv .venv-backend
env -u PIP_INDEX_URL -u PIP_EXTRA_INDEX_URL PIP_CONFIG_FILE=/dev/null \
  .venv-backend/bin/python -m pip install --index-url https://pypi.org/simple \
  -r scripts/benchmark-backends-requirements.txt
node scripts/benchmark-backends.mjs
.venv-backend/bin/python scripts/benchmark-backends.py > evidence/backend-newton-run.log 2>&1
```

## 锁定题目与可比范围

两端固定采用样片顶部两个角点；位移实验另控制底边中点。网格与质量直接由同一输入传给两个后端：

| 输入 | 数值 |
|---|---:|
| 尺寸 | 0.50 × 0.65 m |
| 顶点 / 三角面 | 192 / 330 |
| 面密度 / 总物理质量 | 0.12 kg/m² / 0.039 kg |
| 固定时间步 / 子步 | 1/60 s / 3 |
| 外层迭代 | 8 |
| 重力 | [0, −9.81, 0] m/s² |
| 每个实验 | 90 帧，前 10 帧不计入温态耗时 |
| 位移控制 | 底边中点在 60 帧内移至 +0.10 m 横向、−0.09 m 竖向，保持 30 帧 |

Newton 原始面积分配质量与 XPBD 最大差为 2.98×10⁻¹⁹ kg。固定点在 Newton 中通过零质量处理，其物理质量仍单独保留在输入和总量报告中。Newton 使用 float32；JavaScript 求解使用 float64。

为了避免把不同含义的参数直接设成相同数值，脚本对 XPBD 的全部距离约束施加三个 10⁻⁵ 级别仿射形变，以 `2E/(Aε²)` 计算纯横向、纯纵向和纯剪切的小应变等效模态刚度，再传给 Style3D 的三角各向异性系数：51.5427、98.4997、12.4857 N/m。

**这只匹配三个纯小应变模态。** XPBD 对角弹簧带来的方向耦合、两跳距离“弯曲”与 Style3D 的三角面／曲率弯曲并不相同；Newton 采用 1×10⁻⁶ N·m 的弯曲参数，没有宣称弯曲等价。Style3D 另有每次外层 8 次 PCG 内层迭代。两项都关闭接触、自碰撞、渲染和实测非线性材料曲线，避免混入尚未对齐的模块。这不是实物误差测试，也不是完整丝袜性能测试。

## 真实结果

耗时为每个完整 1/60 s 求解步的墙钟时间，包含三个子步；Python 位移实验包含接口需要的运动点赋值。表中温态均值保留两位小数。

| 后端 / 实验 | 温态均值 | 中位数 | 固定点最大漂移 | 最大 / 平均边应变 | 底边中点 Y |
|---|---:|---:|---:|---:|---:|
| JS XPBD / 重力 | 0.97 ms | 0.89 ms | 0 m | 13.08% / 0.59% | 0.23347 m |
| Newton Style3D / 重力 | 13.29 ms | 11.81 ms | 0 m | 7.79% / 0.48% | 0.23803 m |
| JS XPBD / 位移 | 0.78 ms | 0.76 ms | 0 m | 61.83% / 3.66% | 0.16000 m |
| Newton Style3D / 位移 | 11.63 ms | 11.24 ms | 0 m | 52.41% / 4.05% | 0.16000 m |

两后端、两实验均未出现非有限坐标。较小的应变不能证明更准确：本构和迭代器尚未完全等价，也没有实物测量基准。CPU 耗时只覆盖这个小网格、本机和这组迭代参数，不能外推至 GPU 或高分辨率场景。

Newton 首次重力模型构建／初始化包含 JIT，约 6.20 s；首步另含约 1.08 s 编译。第二个模型复用编译缓存，构建约 0.022 s。初始化与温态统计分开保留。

## 许可证与产品准入

Newton 源码采用 Apache-2.0；本地 `SolverStyle3D` 文件也有对应 SPDX 标记。[Newton LICENSE](https://github.com/newton-physics/newton/blob/main/LICENSE.md)

Warp 根许可证采用 Apache-2.0，但不能据此把预编译依赖整体认定为纯开源。**实际安装的 Warp 1.18 wheel 随附许可写明静态链接 libmathdx，并附 NVIDIA SDK 协议；还存在 NanoVDB 的 proprietary notice，以及 CUDA / NVRTC 等组件许可。** 本次日志显示 CUDA 未启用，这不证明全部随附或链接组件均满足纯开源要求。相关文件的路径、原文摘录已保存在证据中。[Warp LICENSE](https://github.com/NVIDIA/warp/blob/main/LICENSE.md)

因此该隔离环境属于研究证据，不是当前产品的运行依赖，也未通过“全依赖开源”的准入。源码构建是否能排除相关组件，需要另行验证配置和生成物，本文没有把它当成已完成事项。

## 接入工作与当前决定

本次最小适配器已经完成：同一三角网格与面积质量 → 注册 Style3D 自定义属性 → 方向小应变映射 → CPU model/state/control → 固定点与运动点 → 帧输出及统一边应变指标。

接入现有设计平台仍要实现：开缝新增顶点后重建模型与预计算矩阵、保留稳定顶点 ID 和自然长度／局部材料、将 N/m 非线性曲线移植到其力和切线、接触特性对齐，以及前端到 Python 进程的状态传输与调度。此适配器没有承担这些能力。

当前保留浏览器 XPBD 为交互原型后端；Newton 保留为已实际运行的候选研究后端。本机 CPU 小样片实测未提供立即替换的速度理由，预编译依赖许可也尚不满足完整开源准入。后续决定需要来自所选开源构建、目标硬件、同一非线性材料与接触题目的结果。

## 证据文件

- `evidence/backend-input.json`：网格、质量、单位、时间步、仿射能量映射与假设。
- `evidence/backend-xpbd.json`、`backend-newton.json`：版本、各实验统计和全部最终顶点。
- `evidence/backend-newton-run.log`：真实 Warp 初始化、编译和实验日志。
- `evidence/backend-environment.json`：实际版本与平台。
- `evidence/backend-newton-licenses.json`、`backend-warp-licenses.json`、`backend-license-notices.txt`：安装产物许可核查。
- `evidence/backend-source-hashes.json`：本次源文件和输入哈希。

证据目录按项目现有规则被 Git 忽略；交付或归档时应一并保存上述文件，虚拟环境和编译缓存无需作为产品资产发布。
