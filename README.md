# vkcode

**vkcode** is a Zed-inspired fork of Visual Studio Code with a self-contained, **on-device AI** stack — inline chat, inline (ghost-text) suggestions, and commit-message generation — powered by a **local model**. No account, no sign-in, no cloud: everything runs on your machine via a bundled [`llama.cpp`](https://github.com/ggml-org/llama.cpp) server.

## Download & install

Grab an installer from the [**Releases**](../../releases) page:

| Platform | File |
| --- | --- |
| Windows (installer) | `vkcode-win32-x64-user-setup.exe` (per-user) or `…-system-setup.exe` (all users) |
| Windows (portable)  | `vkcode-win32-x64.zip` — unzip and run `vkcode.exe` |
| macOS (Apple Silicon) | `vkcode-darwin-arm64.zip` |
| macOS (Intel) | `vkcode-darwin-x64.zip` |

> Builds are unsigned. On **macOS**, the first launch needs right-click → **Open** (Gatekeeper). On **Windows**, click **More info → Run anyway** if SmartScreen appears.

## Set up the local AI

The AI features need two things on disk: the **llama.cpp server** and at least one **GGUF model**. Both are plain files you point the editor at via settings — no internet required at runtime.

### 1. The model server (engine)

vkcode runs the model with `llama-server.exe` (from llama.cpp's prebuilt CUDA/Metal/CPU release).

- Download the latest prebuilt for your OS from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (e.g. `llama-<build>-bin-win-cuda-12.4-x64.zip`, plus the matching `cudart-*` zip on Windows/NVIDIA).
- Unzip it to a folder, e.g. `D:\vkcode\tools\llamacpp\` (Windows) or `~/vkcode/tools/llamacpp/` (macOS).
- Point vkcode at it in **Settings** → `vkcode.ai.serverPath` (e.g. `D:/osp/vkcode/tools/llamacpp/llama-server.exe`).

### 2. Download a model (GGUF)

Put any number of `*.gguf` files under a **`models`** folder; vkcode auto-discovers them (and any subfolders). Recommended models that fit an 8 GB GPU:

| Model | Good for | Download |
| --- | --- | --- |
| **Qwen2.5-Coder-7B-Instruct** (Q4_K_M, ~4.7 GB) | Code: completion (FIM) + edits + chat | [bartowski/Qwen2.5-Coder-7B-Instruct-GGUF](https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF) |
| **Gemma 4 / Qwen3** | General chat + step-by-step reasoning | search Hugging Face for a recent GGUF |

Place them like this (the folder name `models` is what matters):

```
D:/osp/vkcode/models/
├─ Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
├─ Qwen3.5-4B-Q4_K_M.gguf
└─ gemma/
   └─ Gemma4-E2B-q4_k_m.gguf
```

A fast way to download (multi-connection):

```
aria2c -x16 -s16 -d D:/osp/vkcode/models \
  "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
```

### 3. Point vkcode at a model

Set the active model in **Settings** (use **forward slashes** — backslashes must be escaped in JSON):

```jsonc
{
  "vkcode.ai.model": "d:/osp/vkcode/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
  "vkcode.ai.serverPath": "d:/osp/vkcode/tools/llamacpp/llama-server.exe"
}
```

Or just open the **AI** menu in the status bar and pick a model — it lists everything under your `models` folder and reloads on switch.

### Using it

- **Inline chat / edits** — `Ctrl/Cmd+I` in an editor; select code and ask "add error handling", "improve", etc.
- **Inline suggestions** — ghost text as you type (best with a coder model that supports FIM, like Qwen2.5-Coder).
- **Commit messages** — the ✨ button in the Source Control input.
- **AI menu** (status bar) — toggle AI on/off, switch models, toggle reasoning, view backend/VRAM, see logs, or unload the model to free memory.

### AI settings reference

| Setting | Description |
| --- | --- |
| `vkcode.ai.enabled` | Master on/off switch |
| `vkcode.ai.model` | Path to the active `.gguf` model |
| `vkcode.ai.serverPath` | Path to `llama-server` executable |
| `vkcode.ai.gpu` | `auto` (GPU) / `off` (CPU) |
| `vkcode.ai.contextSize` | Context window; `auto` = 8192 (VRAM-safe) or a number |
| `vkcode.ai.contextSizeByModel` | Per-model context, e.g. `{ "qwen": 8192, "gemma": 16384 }` |
| `vkcode.ai.thinking` | Show step-by-step reasoning (reasoning models only) |

## Build from source

```bash
git clone <this-repo> && cd vkcode
npm ci
./scripts/code.sh          # or scripts\code.bat on Windows
```

Packaged installers are produced by the [`Release`](.github/workflows/release.yml) GitHub Actions workflow (push a `v*` tag).

---

# Visual Studio Code - Open Source ("Code - OSS")
[![Feature Requests](https://img.shields.io/github/issues/microsoft/vscode/feature-request.svg)](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
[![Bugs](https://img.shields.io/github/issues/microsoft/vscode/bug.svg)](https://github.com/microsoft/vscode/issues?utf8=✓&q=is%3Aissue+is%3Aopen+label%3Abug)
[![Gitter](https://img.shields.io/badge/chat-on%20gitter-yellow.svg)](https://gitter.im/Microsoft/vscode)

## The Repository

This repository ("`Code - OSS`") is where we (Microsoft) develop the [Visual Studio Code](https://code.visualstudio.com) product together with the community. Not only do we work on code and issues here, but we also publish our [roadmap](https://github.com/microsoft/vscode/wiki/Roadmap), [monthly iteration plans](https://github.com/microsoft/vscode/wiki/Iteration-Plans), and our [endgame plans](https://github.com/microsoft/vscode/wiki/Running-the-Endgame). This source code is available to everyone under the standard [MIT license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt).

## Visual Studio Code

<p align="center">
  <img alt="VS Code in action" src="https://github.com/user-attachments/assets/56af271c-949d-454c-a3ea-16188c063414">
</p>

[Visual Studio Code](https://code.visualstudio.com) is a distribution of the `Code - OSS` repository with Microsoft-specific customizations released under a traditional [Microsoft product license](https://code.visualstudio.com/License/).

[Visual Studio Code](https://code.visualstudio.com) combines the simplicity of a code editor with what developers need for their core edit-build-debug cycle. It provides comprehensive code editing, navigation, and understanding support along with lightweight debugging, a rich extensibility model, and lightweight integration with existing tools.

Visual Studio Code is updated monthly with new features and bug fixes. You can download it for Windows, macOS, and Linux on [Visual Studio Code's website](https://code.visualstudio.com/Download). To get the latest releases every day, install the [Insiders build](https://code.visualstudio.com/insiders).

## Contributing

There are many ways in which you can participate in this project, for example:

* [Submit bugs and feature requests](https://github.com/microsoft/vscode/issues), and help us verify as they are checked in
* Review [source code changes](https://github.com/microsoft/vscode/pulls)
* Review the [documentation](https://github.com/microsoft/vscode-docs) and make pull requests for anything from typos to new content.

If you are interested in fixing issues and contributing directly to the code base,
please see the document [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute), which covers the following:

* [How to build and run from source](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
* [The development workflow, including debugging and running tests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#debugging)
* [Coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines)
* [Submitting pull requests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#pull-requests)
* [Finding an issue to work on](https://github.com/microsoft/vscode/wiki/How-to-Contribute#where-to-contribute)
* [Contributing to translations](https://aka.ms/vscodeloc)

## Feedback

* Ask a question on [Stack Overflow](https://stackoverflow.com/questions/tagged/vscode)
* [Request a new feature](CONTRIBUTING.md)
* Upvote [popular feature requests](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
* [File an issue](https://github.com/microsoft/vscode/issues)
* Connect with the extension author community on [GitHub Discussions](https://github.com/microsoft/vscode-discussions/discussions) or [Slack](https://aka.ms/vscode-dev-community)
* Follow [@code](https://x.com/code) and let us know what you think!

See our [wiki](https://github.com/microsoft/vscode/wiki/Feedback-Channels) for a description of each of these channels and information on some other available community-driven channels.

## Related Projects

Many of the core components and extensions to VS Code live in their own repositories on GitHub. For example, the [node debug adapter](https://github.com/microsoft/vscode-node-debug) and the [mono debug adapter](https://github.com/microsoft/vscode-mono-debug) repositories are separate from each other. For a complete list, please visit the [Related Projects](https://github.com/microsoft/vscode/wiki/Related-Projects) page on our [wiki](https://github.com/microsoft/vscode/wiki).

## Bundled Extensions

VS Code includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (inline suggestions, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

## Development Container

This repository includes a Visual Studio Code Dev Containers / GitHub Codespaces development container.

* For [Dev Containers](https://aka.ms/vscode-remote/download/containers), use the **Dev Containers: Clone Repository in Container Volume...** command which creates a Docker volume for better disk I/O on macOS and Windows.
  * If you already have VS Code and Docker installed, you can also click [here](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode) to get started. This will cause VS Code to automatically install the Dev Containers extension if needed, clone the source code into a container volume, and spin up a dev container for use.

* For Codespaces, install the [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) extension in VS Code, and use the **Codespaces: Create New Codespace** command.

Docker / the Codespace should have at least **4 cores and 6 GB of RAM (8 GB recommended)** to run a full build. See the [development container README](.devcontainer/README.md) for more information.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.

<!-- vkcode ai test 1e93fb3f -->
