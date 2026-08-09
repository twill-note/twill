# Twill

Twill은 로컬에서 실행되는 노트 애플리케이션입니다. Python 기반 백엔드와 React/Electron 기반 데스크톱 화면으로 구성되어 있습니다.

## Windows에서 빠르게 시작하기

저장소를 내려받은 뒤 PowerShell에서 다음 명령을 실행합니다.

```powershell
cd C:\Users\사용자이름\Desktop\twill\window
.\run-desktop.bat
```

첫 실행 시 스크립트가 다음 작업을 자동으로 수행합니다.

1. Python 3.11 이상과 Node.js 20 이상을 확인합니다.
2. 필요한 프로그램이 없으면 `winget`으로 설치합니다.
3. `backend\.venv` Python 가상환경을 만듭니다.
4. 백엔드 및 프런트엔드 패키지를 설치합니다.
5. 프런트엔드를 빌드하고 Electron 데스크톱 앱을 실행합니다.

최초 실행에는 패키지 다운로드와 빌드 때문에 몇 분이 걸릴 수 있습니다. 이후에는 설치 상태를 재사용하므로 더 빠르게 실행됩니다.

### 필수 구성요소만 먼저 설치하기

앱을 실행하지 않고 Python과 Node.js만 먼저 확인하거나 설치하려면 다음 명령을 사용합니다.

```powershell
cd C:\Users\사용자이름\Desktop\twill\window
.\install-prerequisites.bat
```

필수 프로그램이 없는 경우 현재 Windows 사용자 계정에 다음 버전이 설치됩니다.

- Python 3.12
- Node.js LTS

자동 설치에는 Windows 패키지 관리자인 `winget`이 필요합니다. `winget`을 찾을 수 없다는 메시지가 나오면 Microsoft Store에서 **앱 설치 관리자(App Installer)**를 설치하거나 업데이트한 뒤 다시 실행합니다.

### 브라우저 개발 모드로 실행하기

Electron 대신 백엔드와 Vite 개발 서버를 실행하려면 다음 명령을 사용합니다.

```powershell
cd C:\Users\사용자이름\Desktop\twill\window
.\run.bat
```

기본 접속 주소는 `http://127.0.0.1:5173`입니다. 종료하려면 실행한 터미널에서 `Ctrl+C`를 누릅니다.

## macOS 및 Linux

macOS/Linux용 스크립트는 Python 3, Node.js 및 npm이 이미 설치되어 있다고 가정합니다.

```bash
cd /path/to/twill
./mac/run-desktop.sh
```

의존성만 구성하려면 다음을 실행합니다.

```bash
./mac/setup.sh
```

브라우저 개발 모드는 다음 명령으로 실행합니다.

```bash
./mac/run.sh
```

## 수동 설치 요구 사항

자동 설치를 사용하지 않는 경우 다음 프로그램이 필요합니다.

- Python 3.11 이상
- Node.js 20 이상과 npm
- 인터넷 연결: 최초 Python 및 npm 패키지 설치에 필요

Windows에서는 Microsoft Store의 Python 실행 별칭보다 [python.org](https://www.python.org/downloads/windows/) 설치본 사용을 권장합니다.

## 자주 발생하는 문제

### `winget`을 찾을 수 없음

Microsoft Store에서 **앱 설치 관리자(App Installer)**를 설치 또는 업데이트하고 새 PowerShell 창에서 다시 실행합니다.

### Python 가상환경 생성이 중단됨

열려 있는 Twill 프로세스를 모두 종료한 뒤 `window\install-prerequisites.bat`를 먼저 실행하고 다시 시도합니다. 설치 스크립트는 Microsoft Store 실행 별칭을 제외하고 실제 Python 설치 경로를 선택합니다.

### 패키지 설치가 실패함

인터넷 연결과 방화벽 또는 프록시 설정을 확인한 뒤 같은 실행 스크립트를 다시 실행합니다. 완료된 설치 단계는 재사용됩니다.

### 환경을 처음부터 다시 구성하고 싶음

Twill을 모두 종료한 뒤 다음 폴더를 삭제하고 실행 스크립트를 다시 실행합니다.

```text
backend\.venv
frontend\node_modules
frontend\dist
```

이 폴더에는 자동 생성된 파일만 들어 있으며 다음 실행에서 다시 만들어집니다.

## 주요 실행 스크립트

| 경로 | 용도 |
| --- | --- |
| `window\run-desktop.bat` | Windows Electron 앱 구성 및 실행 |
| `window\install-prerequisites.bat` | Windows 필수 프로그램 확인 및 자동 설치 |
| `window\setup.bat` | Windows 프로젝트 의존성 구성 |
| `window\run.bat` | Windows 브라우저 개발 모드 실행 |
| `mac/run-desktop.sh` | macOS/Linux Electron 앱 구성 및 실행 |
| `mac/setup.sh` | macOS/Linux 프로젝트 의존성 구성 |
| `mac/run.sh` | macOS/Linux 브라우저 개발 모드 실행 |
| `mac/build-installer.sh` | macOS DMG 설치 이미지 생성 |

## Windows 설치 프로그램 만들기

배포 담당자는 Windows PC에서 다음 명령을 실행해 독립 실행형 설치 프로그램을 만들 수 있습니다.

```powershell
cd C:\Users\사용자이름\Desktop\twill\window
.\build-installer.bat
```

빌드 과정은 프런트엔드를 생성하고, Python 백엔드를 PyInstaller 실행 파일로 묶은 뒤, Electron과 함께 NSIS 설치 프로그램으로 패키징합니다. 최초 빌드에는 필요한 도구와 Electron 다운로드 때문에 시간이 걸릴 수 있습니다.

완성된 파일은 다음 위치에 생성됩니다.

```text
frontend\release\Twill-Setup-<버전>.exe
```

이 Setup 파일 하나만 배포하면 됩니다. 최종 사용자의 PC에는 Python, Node.js 또는 개발 도구가 설치되어 있지 않아도 됩니다. 설치 마법사에서 설치 위치를 선택할 수 있으며 바탕화면과 시작 메뉴에 Twill 바로가기가 생성됩니다.

설치형 앱의 기본 노트 저장 위치는 사용자의 문서 폴더 아래입니다.

```text
C:\Users\사용자이름\Documents\Twill
```

새 버전을 배포하기 전에는 `frontend/package.json`의 `version` 값을 변경한 뒤 설치 프로그램을 다시 빌드합니다.

> 현재 GitHub Release용 설치 프로그램은 코드 서명되지 않습니다. Windows에서는 SmartScreen의 알 수 없는 게시자 경고가 표시될 수 있으며, macOS에서는 처음 실행할 때 개인정보 보호 및 보안 설정에서 실행을 허용해야 할 수 있습니다. 코드 서명과 공증은 상업적 공개 배포 단계에서 적용합니다.

## macOS 설치 프로그램 만들기

macOS 설치 이미지는 대상 Mac에서 직접 빌드해야 합니다. Python 3.11 이상, Node.js 20 이상과 npm을 설치한 뒤 다음 명령을 실행합니다.

```bash
cd /path/to/twill
chmod +x mac/build-installer.sh
./mac/build-installer.sh
```

스크립트는 현재 Mac의 아키텍처에 맞는 Python 백엔드를 만들고 Electron 앱과 함께 DMG로 패키징합니다. Apple Silicon용 설치본은 Apple Silicon Mac에서, Intel용 설치본은 Intel Mac에서 각각 빌드하는 것이 가장 안전합니다.

완성된 파일은 다음 위치에 생성됩니다.

```text
frontend/release/Twill-<버전>-<아키텍처>.dmg
```

DMG 파일 하나를 GitHub Releases에 올리면 됩니다. 사용자는 DMG를 연 뒤 Twill을 Applications 폴더로 끌어 놓아 설치할 수 있습니다.
