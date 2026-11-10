import type { BrowserProjectConfig } from '../../scripts/jsb.react-browser/src/contracts.js';
import type { EditorProject } from '../../scripts/jsb.react-browser/src/project-document.js';
import station from './examples/station/App.tsx.txt';
import upgrades from './examples/station/Upgrade.tsx.txt';
import game from './examples/station/game.ts.txt';
import squad from './examples/squad/App.tsx.txt';
import media from './examples/media/App.tsx.txt';
import physics from './examples/physics/App.tsx.txt';
import game2d from './examples/game2d/App.tsx.txt';
import art from './examples/art.json';

type Project = EditorProject;
const counterFiles = {
  '/src/App.tsx': `import * as React from 'react';\nimport { Column, Text } from '@godot-js/react/ui';\nimport Counter from './Counter';\n\nexport default function App() {\n  return <Column name="App">\n    <Counter />\n    <Text text="TSX / browser compiler / Godot WASM" />\n  </Column>;\n}\n`,
  '/src/Counter.tsx': `import * as React from 'react';\nimport { VBoxContainer, Label, Button, useNodeRef } from '@godot-js/react';\nimport { caption } from './model';\n\nexport default function Counter() {\n  const [count, setCount] = React.useState(0);\n  const label = useNodeRef<'Label'>();\n  React.useLayoutEffect(() => {\n    console.log('PLAYGROUND_COUNTER ' + JSON.stringify({ count, text: label.current?.read('text') }));\n  }, [count]);\n  return <VBoxContainer name="Counter" customMinimumSize={{ x: 360, y: 120 }}>\n    <Label ref={label} text={caption(count)} />\n    <Button text="Add" onPressed={() => setCount(n => n + 1)} />\n  </VBoxContainer>;\n}\n`,
  '/src/model.ts': `import clsx from 'clsx';\n\nexport function caption(count: number): string {\n  return clsx('Count:') + ' ' + count;\n}\n`,
};
const baseConfig: BrowserProjectConfig = { schemaVersion: 1, entry: '/src/App.tsx', dependencies: { clsx: '2.1.1' }, mode: 'production', profileId: 'core-ui-v1' };

const bytes = (name: keyof typeof art) => Array.from(atob(art[name]), char => char.charCodeAt(0));
function notes(title: string, body: string): string { return '# ' + title + '\n\n' + body + '\n'; }
export function createExample(name = 'starter'): Project {
  if (name === 'game2d') return { config: { ...baseConfig, profileId: 'game-2d-v1', dependencies: {}, assets: {
    rover: { source: '/assets/rover.png', type: 'Texture2D' }, ship: { source: '/assets/ship.png', type: 'Texture2D' }, crystal: { source: '/assets/crystal.png', type: 'Texture2D' },
    floor: { source: '/assets/floor.tres', type: 'RectangleShape2D' }, wall: { source: '/assets/wall.tres', type: 'RectangleShape2D' }, actor: { source: '/assets/actor.tres', type: 'CircleShape2D' },
  } }, selected: '/src/App.tsx', files: {
    '/src/App.tsx': game2d, '/assets/rover.png': bytes('rover'), '/assets/ship.png': bytes('ship'), '/assets/crystal.png': bytes('crystal'),
    '/assets/floor.tres': '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(528, 16)\n',
    '/assets/wall.tres': '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(12, 180)\n',
    '/assets/actor.tres': '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = 12.0\n',
    '/README.md': notes('贴图碰撞实验场', '小车贴图跟随真实 CharacterBody2D 在封闭场地内运动。Launch 向上发射，Pause/Resume 暂停或继续运动，Reset 重建角色，Rover/Ship 切换预加载贴图而不重建碰撞体。\n\nReact 管理 HUD 和场景结构，usePhysicsProcess 独占角色的位置与速度，Sprite2D 通过原生父子关系跟随。全部贴图和形状在 World 发布前加载完成。\n\n练习：更换 PNG、调整重力、初速度或形状大小。此示例使用 game-2d-v1，将 UI、图片与 2D 物理放在同一个能力范围中。'),
  } };
  if (name === 'counter') return { config: structuredClone(baseConfig), files: { ...counterFiles }, selected: '/src/Counter.tsx' };
  if (name === 'state') return { config: { ...baseConfig, dependencies: {} }, selected: '/src/App.tsx', files: {
    '/src/App.tsx': squad,
    '/README.md': notes('小队编成', '点击 Recruit/ON BOARD 调整队员。在 5 点能量预算内凑够 80 战力，然后发射。\n\n练习：修改 crew 数据添加队员，或者调整预算。CrewCard 从 Context 读取共享状态，Toggle 使用受控模式，列表使用稳定的 key。'),
  } };
  if (name === 'media') return { config: { ...baseConfig, profileId: 'ui-media-v1', dependencies: {}, assets: {
    rover: { source: '/assets/rover.png', type: 'Texture2D' }, ship: { source: '/assets/ship.png', type: 'Texture2D' }, crystal: { source: '/assets/crystal.png', type: 'Texture2D' },
  } }, selected: '/src/App.tsx', files: { '/src/App.tsx': media,
    '/assets/rover.png': bytes('rover'), '/assets/ship.png': bytes('ship'), '/assets/crystal.png': bytes('crystal'),
    '/README.md': notes('像素素材实验室', '切换三张原创 PNG，试试镜像、缩放和三种配色。文件树中可直接查看图片资源。\n\n练习：添加自己的 PNG，在 assets 配置中注册，并添加到贴图列表；调整 TextureRect 的 stretchMode 比较效果。'),
  } };
  if (name === 'physics') return { config: { ...baseConfig, profileId: 'behavior-physics-v1', dependencies: {}, assets: {
    floor: { source: '/assets/floor.tres', type: 'RectangleShape2D' }, wall: { source: '/assets/wall.tres', type: 'RectangleShape2D' }, ball: { source: '/assets/ball.tres', type: 'CircleShape2D' },
  } }, selected: '/src/App.tsx', files: { '/src/App.tsx': physics,
    '/assets/floor.tres': '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(424, 16)\n',
    '/assets/wall.tres': '[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(12, 188)\n',
    '/assets/ball.tres': '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = 12.0\n',
    '/README.md': notes('弹跳实验场', '橙色探测器在封闭场地内自动弹跳。Launch 施加冲量，Earth/Moon 切换重力，Pause 冻结物理回调，Reset 重新生成小球。\n\n练习：修改重力、初速度、反弹系数和形状大小。React 管理控制面板，usePhysicsProcess 管理引擎拥有的位置和速度。'),
  } };
  if (name === 'errors') return { config: { ...baseConfig, dependencies: {} }, selected: '/src/App.tsx', files: { '/src/App.tsx': `import * as React from 'react';
import { Label } from '@godot-js/react';

// 将 text 改为字符串后运行；尝试点击问题面板跳转到错误位置。
export default function App() {
  return <Label text={123} />;
}
` } };
  return { config: { ...baseConfig, profileId: 'ui-media-v1', dependencies: {}, assets: { outpost: { source: '/assets/outpost.png', type: 'Texture2D' } } }, selected: '/src/App.tsx', files: {
    '/src/App.tsx': station, '/src/Upgrade.tsx': upgrades, '/src/game.ts': game, '/assets/outpost.png': bytes('outpost'),
    '/README.md': notes('星际补给站', '点击 Mine asteroid 采集矿石，购买钻头升级和自动采矿无人机，累计采集 120 矿石完成任务。升级会花费库存，但不扣除任务进度。Pause 暂停操作及自动采集，New expedition 重新开始。\n\n练习：在 src/game.ts 中调整目标、收益和升级价格；在 Upgrade.tsx 中修改卡片；在 App.tsx 中扩展任务。使用 useReducer 维护规则，useEffect 清理计时器，Suspense 加载本地图片。'),
  } };
}
