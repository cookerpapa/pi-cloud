# Third-party and file-specific licenses

The root [MIT license](LICENSE) applies to PiCloud-authored material unless a file
or component states otherwise. It does not replace third-party licenses or
copyright notices. Retain those notices when redistributing the corresponding
material or build artifacts.

| Material | License and attribution |
| --- | --- |
| [Pi output truncation helpers](packages/tool-sandbox/src/tool-output-truncation.ts) | MIT; Copyright (c) 2025 Mario Zechner. The full original notice, source reference and modification notes remain in the file. |
| [PiCloud POSIX Volume plugin](deploy/cubesandbox/cube-volume-picloud-posix.sh) | Its existing [Apache-2.0](LICENSES/Apache-2.0.txt) SPDX declaration and PiCloud contributors copyright remain in effect. |
| [CubeSandbox patches](deploy/cubesandbox/patches/) and build integration | Target Tencent's CubeSandbox. Its [license](https://github.com/TencentCloud/CubeSandbox/blob/8721dd151971ce3c2966482bbd32904ad98f378e/LICENSE) specifies Apache-2.0 with component-specific exceptions. Preserve upstream notices and the licenses of included components. |
| [CLIProxyAPI patches and adapters](deploy/provider-gateway/) | Integrate with MIT-licensed CLIProxyAPI; upstream copyright notices name Luis Pater and Router-For.ME. Upstream material retains its [license](https://github.com/cookerpapa/CLIProxyAPI/blob/7baeffb84befe97ad6af1f95249f293251000458/LICENSE). |
| Prepared Appium UiAutomator2 driver | Apache-2.0. The [pinned upstream package](deploy/android/automation/upstream-driver.json) is fetched during preparation; its license and upstream code are preserved by the preparation script. Its package manifest is not relabelled as PiCloud-owned code. |

Pi, Chord and other installed dependencies, downloaded source trees, base images,
fonts and bundled tools retain their own licenses. Their package metadata,
distributed license files and release SBOMs identify the applicable components.
This summary is not a replacement for those materials or a complete inventory of
every dependency in every optional build.
