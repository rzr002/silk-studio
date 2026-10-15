# IPC Toolkit 实测接入记录

2026-10-15。结论：官方开源 `ipctk 1.6.0` 已在本机安装并实际计算，能抓住现有 JS 求解器漏掉的边—边穿越，已进一步接入本地实验参考后端。**本记录的基础探针不代表整袜或 55° 动态门禁通过；后续整袜结果按具体源码版本单独审计。**

当前产品入口已增加 `native-simulation.mjs` 与 `scripts/server.py`。旧版本 `def01221c058445d2c4b8501799d792e0adbc4fa965b9ec63672cc969cbba7fe` 记录保留为历史证据，该版跨HTTP步的contact reference有一致性问题。当前固定reference版本为 `c74465712d4628cc90fcdf45e5d9814ce58c7a8f04f1fd4469d0730d72b4b4df`，14项原生测试、完整离线静态与两个小角度请求通过。随后真实UI完整0→55°也通过：81接受步骤，完整dt/目标姿态及收敛成立，终态几何强审计通过，材料拒绝不改变接受状态。证据为 `evidence/backend-ipc-fixed-*` 与 `evidence/native-motion-browser-report.json`；具体配置、耗时和未校准边界见 `VERIFICATION.md`。

## 已实际运行

环境为 macOS 15.5 / arm64、Python 3.13.2。临时隔离解释器：`/tmp/silk-ipctk-env/bin/python`。官方 PyPI 提供匹配的 macOS arm64 wheel，实装为 `ipctk 1.6.0`、`numpy 2.5.4`、`scipy 1.18.1`，未修改全局 Python 包。安装方式与 wheel 来源见 [官方安装说明](https://ipctk.xyz/build/python.html) 和 [官方 PyPI 发布页](https://pypi.org/project/ipctk/)。

复现命令：

```bash
python3 -m venv /tmp/silk-ipctk-env
/tmp/silk-ipctk-env/bin/python -m pip --isolated --disable-pip-version-check install --index-url https://pypi.org/simple --only-binary=:all: -r scripts/ipc-probe.requirements.txt
TBB_NUM_THREADS=1 /tmp/silk-ipctk-env/bin/python scripts/ipc-probe.test.py
node scripts/ipc-probe.mjs /tmp/silk-ipc-fit3.json .003
node scripts/ipc-probe.mjs /tmp/silk-ipc-fit6.json .006
TBB_NUM_THREADS=1 /tmp/silk-ipctk-env/bin/python scripts/ipc-probe.py --stocking-input /tmp/silk-ipc-fit3.json --min-distance 0 --output evidence/ipc-fit3-zero.json
TBB_NUM_THREADS=1 /tmp/silk-ipctk-env/bin/python scripts/ipc-probe.py --stocking-input /tmp/silk-ipc-fit6.json --min-distance .001 --output evidence/ipc-fit6-one-mm.json
```

6 项真实原生库测试先红后绿，未 mock CCD 或导数：

| 实验 | 实测结果 |
| --- | --- |
| 两条边中部穿越，4 个点—边端点测试全部未碰撞 | edge-edge hit=true；解析碰撞时刻 .5，安全步长 .494995117 |
| 上例要求最小间距 1mm | 安全步长 .444976807，接受后的间距 1.10046mm |
| 共面运动的两条边 | hit=true，安全步长 .244995117，未跳过退化共面情况 |
| 点穿过静止三角面 / 移动三角面 | 均检测到，后者安全步长 .430419922，解析碰撞时刻 .434782609 |
| barrier E/g/H | 能量及导数有限，18 维 gradient、18×18 稀疏 Hessian；有限差分相对误差约 1e-9 |
| 固定人台三角形，只优化衣物三角形 9 个自由度 | 质量惯性 + barrier、Newton + CCD/Armijo，22 次迭代，梯度范数 9.1e-11；穿体目标最终保留约 60µm 正间距，人体坐标完全未改 |

最后一项是最小求解示例，未包含服装弹性、本构校准或整袜质量保证；实现见 `scripts/ipc-probe.py::cloth_only_optimization_probe`。

## 真实丝袜网格结果与过滤证据

候选来自当前 `SimulationEngine` 的真实一步 0→0.7°、dt=1/60：1981 衣物点 + 2621 人体点，9158 面、13757 唯一边。以下都是原生 feature 距离，**不是只测顶点或面心**。

| 初始 fit / 接触要求 | cloth-body 最小距离 | 原生 CCD 及复核 |
| --- | --- | --- |
| fit3mm / dmin1mm | 0.0784319mm | 初态不满足最小距离，必须拒绝推进，alpha=0 |
| fit3mm / dmin0 | 0.0784319mm | 原始 alpha=.020721436；连续路径复核后收缩一次至 .010360718，复核 true，终点交叉 false |
| fit6mm / dmin1mm | 3.0218886mm | alpha=.241729736，连续路径复核 true，终点交叉 false |

最小 cloth-body stencil 是 `FaceVertexNormalCollision`：人体全局点 2721（人体局部点 740），衣物三角形 `[540,581,580]`。它明确跨两组，**不是人体自身或封尖内部邻接的伪接触**。fit6 启用衣物自碰撞后，全局最小值为 1.982956mm，来自衣物 cap 的非共享局部 feature，仍满足 1mm。

过滤锁定为当前 **1.6.0**：

```python
# 数组排列：衣物在前 n_cloth 个，人体随后。
# 诊断模式：只保留 cloth-body，两个组的内部完全禁止。
mesh.can_collide = ipctk.make_vertex_patches_filter(
    np.r_[np.zeros(n_cloth, dtype=np.int32), np.ones(n_body, dtype=np.int32)]
)
# 完整接触模式：保留 cloth-cloth 和 cloth-body，禁止所有 body-body。
mesh.can_collide = ipctk.make_static_obstacle_filter(n_cloth)
```

原生 BroadPhase 已排除共端点的 edge-edge、包含该顶点的 face-vertex 等合法共享拓扑；相邻静止双三角形实测 active collisions=0、安全步长=1。不可用“全衣物同一 patch”来关闭自碰撞后再宣称支持自接触。厚度大于细网格合法非共享 feature 间距时，还需要材料局部邻域规则或更合适的厚度。1.6.0 源码 primitive filter 聚合为 **OR**，不要混用当前网站 main 版本说明的 AND 语义。[版本固定的 BroadPhase 源码](https://github.com/ipc-sim/ipc-toolkit/blob/v1.6.0/src/ipc/broad_phase/broad_phase.cpp)、[过滤说明](https://ipctk.xyz/tutorials/faq.html)。

单线程本机这一次实测：mesh 构建约 4–5ms，原生初态交叉检查约 10–19ms。fit3 的 CCD 加路径复核约 95ms（仅 cloth-body）/121ms（含衣物自接触）。fit6 对应约 234ms/522ms；这是一次候选查询，**不含 Newton 迭代、数据传输或整步求解**，不能推导实时帧率。原始结果保存在上述 `evidence/ipc-fit*.json`。

## 给物理求解器的准确 API

输入位置为 `float64 (#V,3)`，拓扑为 `int32 (#F,3)`，传给 pybind11 可用 `np.asfortranarray`。**导数向量是 vertex-major xyz**，此版本已做有限差分验证，取矩阵 DOF 时使用 `reshape(-1)` 的默认 C 排列。

```python
faces = np.asarray(faces, dtype=np.int32).reshape(-1, 3)
edges = ipctk.edges(faces)
mesh = ipctk.CollisionMesh(rest_positions, edges, faces)
contacts = ipctk.NormalCollisions()
contacts.build(mesh, X, dhat, dmin)
B = ipctk.BarrierPotential(dhat, stiffness=stiffness)
E = B(contacts, mesh, X)
g = B.gradient(contacts, mesh, X)
H = B.hessian(contacts, mesh, X, ipctk.PSDProjectionMethod.CLAMP)
alpha = ipctk.compute_collision_free_stepsize(mesh, X0, X1, min_distance=dmin)
```

`H` 是 SciPy CSC。`B` 已含 stiffness，避免重复乘。`PSDProjectionMethod.CLAMP` 是 Hessian 正半定化，**不是将穿体几何投影出去**。Toolkit 提供 barrier、导数、摩擦及 CCD 组件，完整服装势能/惯性与非线性求解仍由宿主实现。[官方 potentials API](https://ipctk.xyz/python-api/potentials.html)、[官方 CCD API](https://ipctk.xyz/python-api/ccd.html)、[项目能力与限制](https://pypi.org/project/ipctk/)。

固定人体时，只对 cloth 自由度求解 `g[free]` / `H[free,free]`，再加入衣物弹性、质量惯性与固定点边界；保持人体 DOF 不进入线性系统。示例已实际跑通此形式。

注意版本实测差异：`NormalCollisions.compute_minimum_distance` 返回**平方距离**，需开方才是米；500µm 平行面的返回值为 2.5e-7。`collisions[i]` 是借用原生 stencil 的引用，不可让其寿命超出父 collision set；一次探索在退出时出现过 native segfault。探针只从临时 stencil 拷贝数值，并在父集合存活期间使用，已重跑正常退出。不要跨迭代缓存 stencil Python 对象。

每次提交更新前须用 `is_step_collision_free` 复核，必要时减半；`verified_safe_step` 已包含这层逻辑。CCD 假定初态无相交且满足 dmin；不能修复既有穿入状态。移动人体必须将人体 **X0、X1** 一起参与 CCD。若 alpha<1，要同时保持衣物/人体实际提交几何与 UI 已提交姿态一致；不能只截断衣物、让人体跳到目标姿态。线性 CCD 仅保证线性轨迹；大角度旋转需细分或使用经过验证的非线性轨迹方案。[官方 CCD 前提](https://ipctk.xyz/python-api/ccd.html)。

## 开源与依赖

核心 MIT，许可允许修改和商用并要求保留版权/许可通知。[官方许可](https://ipctk.xyz/about/license.html)。

| 依赖 | 官方标注许可 |
| --- | --- |
| Eigen、libigl | MPL-2.0 |
| oneTBB、Scalable-CCD | Apache-2.0 |
| Tight-Inclusion、spdlog、TinyAD、robin-map | MIT |
| xsimd、pybind11 | BSD-3-Clause |
| filib（可选，默认启用） | LGPL-2.1 |

这些均为开源依赖，没有闭源付费服务。不能把整套默认构建称为“全 MIT”；尤其 filib 默认选项涉及 LGPL。[官方依赖表](https://ipctk.xyz/about/dependencies.html)。本次 wheel `otool -L` 仅列 macOS 系统 `libSystem/libc++`；这不能证明其静态捆绑依赖的完整清单，发行前仍需按实际构建保留各许可证。

本机 wheel 可用，**没有宣称完成源码构建**。如果产品希望避免 LGPL 部件，固定 1.6.0 源码，设置 `IPC_TOOLKIT_WITH_FILIB=OFF`，同时保留 `IPC_TOOLKIT_WITH_INEXACT_CCD=OFF`；C++17、CMake>=3.24。1.6.0 `setup.py` 实际支持 `CMAKE_ARGS`，可用于传这些选项；然后必须重新跑本探针和整袜门禁。[版本固定的 CMake 选项](https://github.com/ipc-sim/ipc-toolkit/blob/v1.6.0/CMakeLists.txt)、[setup.py 参数来源](https://github.com/ipc-sim/ipc-toolkit/blob/v1.6.0/setup.py)。

## 本地后端实现与后续建议

当前采用固定依赖的独立Python环境、标准库HTTP server及同源浏览器adapter，只监听 `127.0.0.1`。每个请求为无服务端模型会话的独立求解，串行锁保护原生库；已有计算时新请求返回429，不排队。界面显示实际等待耗时、接受后的姿态与时间；取消等待不保证中断已开始的原生求解。任务队列与任务轮询仅是后续可能方案，当前没有实现。

依赖解释器可通过项目变量 `SILK_IPC_PYTHON` 指定，当前产品使用项目独立 `.venv-ipc` 和固定requirements。拓扑、稀疏结构及CollisionMesh按设计revision跨请求缓存可作为后续优化方向，当前尚未实现。输入包含设计ID、revision、epoch、自然几何、当前位置/速度、质量、约束、pins、canonical人体参考位置、人体前后位置和目标姿态；输出带已提交姿态、能量/收敛状态、接触审计与拒绝原因。过期epoch不得覆盖当前设计。

本轮指定完整丝袜的静态及0→55°真实UI验收已完成，含toe覆盖、全部面/边内部采样、原生与独立交叉检查、固定点、应变/收敛及实际耗时。它仍是无摩擦、未标定线性材料的慢速参考：运动/末态保持的1.333秒物理时间实际等待约52.7分钟。后续需要性能profiling、非线性材料与摩擦、更多编辑/动作反例、真实样品校准；不能由这一个通过案例推导任意设计可靠或可实机生产。
