# FMS ROI Topology Editor

ROS 맵 위에 노드와 엣지를 배치해서 토폴로지를 편집하는 Vite + React 기반 에디터입니다.

## 주요 기능

- `.yaml` + `.pgm` 맵 업로드
- 노드 생성, 이동, 다중 선택, 삭제
- 엣지 생성 및 방향 전환
- 우클릭 컨텍스트 메뉴
- Inspector 패널에서 선택 객체 편집
- 토폴로지 JSON 저장 / 불러오기
- 브라우저 local draft 자동 저장 / 복원
- 노드 이름 라벨, 엣지 거리 라벨 토글

## 실행 방법

```bash
npm install
npm run dev
```

빌드 확인:

```bash
npm run build
```

## 기본 사용법

### 맵 불러오기

- `Map` 버튼으로 `.yaml`, `.yml`, `.pgm` 파일을 함께 선택합니다.
- YAML의 `image` 파일명과 업로드한 PGM 파일의 basename이 일치해야 합니다.

### 토폴로지 편집

- 빈 캔버스를 더블클릭하면 현재 선택된 타입의 노드가 생성됩니다.
- 노드를 드래그하면 이동합니다.
- 빈 공간 드래그로 박스 선택이 가능합니다.
- `Shift + 클릭`으로 선택에 추가/제거할 수 있습니다.
- `Edge` 모드에서 노드 A와 B를 클릭하거나 드래그해서 엣지를 만들 수 있습니다.

### 보기 옵션

- 상단 `Tools` 영역의 `Node Names`로 노드 이름 표시를 켜고 끌 수 있습니다.
- 상단 `Tools` 영역의 `Edge Distance`로 엣지 거리 표시를 켜고 끌 수 있습니다.

## 단축키

- `Space` + 드래그: 화면 이동
- `Ctrl/Cmd + Z`: Undo
- `Ctrl/Cmd + Shift + Z`: Redo
- `Ctrl/Cmd + Y`: Redo
- `Ctrl/Cmd + A`: 전체 선택
- `Ctrl/Cmd + C`: 선택 복사
- `Ctrl/Cmd + V`: 마우스 위치에 붙여넣기
- `Ctrl/Cmd + S`: JSON 저장
- `Ctrl/Cmd + O`: JSON 불러오기
- `Ctrl/Cmd + 0`: 화면 맞춤
- `Delete` / `Backspace`: 선택 삭제
- `1`: Destination
- `2`: Waypoint
- `3`: Charge Station
- `4`: Waiting Position
- `E`: Edge 모드 토글

## 저장 동작

### JSON 저장

- 토폴로지 문서만 저장합니다.
- 배경 맵 raster 자체는 포함하지 않습니다.

### Local Draft

- 문서와 현재 view 상태를 브라우저에 자동 저장합니다.
- 페이지를 다시 열면 임시 저장본을 복원할 수 있습니다.
- 맵 raster는 런타임 데이터라서, 드래프트 복원 후에는 배경 맵을 다시 업로드해야 합니다.

## 프로젝트 구조

```text
src/
  components/
    Toolbar.tsx
    InspectorPanel.tsx
    StatusBar.tsx
    ContextMenuView.tsx
    NodeEditorDialog.tsx
    RecoveryBanner.tsx
    TopologyCanvas.tsx
  store/
    editorStore.ts
  utils/
    geometry.ts
    localDraft.ts
    mapFiles.ts
    topology.ts
    viewState.ts
  App.tsx
  types.ts
```

## 참고

- UI 상태용 view 값은 `src/utils/viewState.ts`에서 기본값과 sanitize를 공통 관리합니다.
- 현재 검증 커맨드는 `npm run build` 기준입니다.
