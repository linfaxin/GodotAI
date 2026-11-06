export const catalog=[
  {id:"shader",name:"Shader 实验室",subtitle:"LIGHT / COLOR / MOTION",file:"ShaderLab.tsx",hint:"移动鼠标改变场域，调节参数探索三种实时材质。",accent:"#a79bff",controls:[
    {key:"intensity",label:"场域强度",min:.2,max:3,step:.05,value:1},
    {key:"speed",label:"流动速度",min:0,max:3,step:.05,value:1},
    {key:"effect",label:"色彩偏移",min:0,max:2,step:.05,value:0},
  ]},
  {id:"lights",name:"交互光影房间",subtitle:"SHADOW / SPACE / TOUCH",file:"LightRoom.tsx",hint:"移动鼠标控制青色光源，按住方块拖动遮挡物。",accent:"#6ae2d4",controls:[
    {key:"energy",label:"灯光能量",min:.2,max:3,step:.05,value:1.2},
    {key:"speed",label:"环绕速度",min:0,max:2,step:.05,value:.7},
    {key:"shadows",label:"动态阴影",min:0,max:1,step:1,value:1},
  ]},
  {id:"islands",name:"Kenney 浮空岛",subtitle:"JUMP / COLLECT / EXPLORE",file:"SkyIslands.tsx",hint:"点击画面后用 WASD 移动，空格二段跳，R 回到起点。收齐 6 枚金币。",accent:"#ffd08a",controls:[
    {key:"speed",label:"移动速度",min:2,max:9,step:.25,value:5},
    {key:"jump",label:"跳跃力度",min:5,max:12,step:.25,value:8},
    {key:"gravity",label:"重力",min:10,max:35,step:1,value:22},
    {key:"collapse",label:"平台下落",min:0,max:2,step:.1,value:1},
  ]},
  {id:"city",name:"积木城市",subtitle:"BUILD / ROTATE / REMIX",file:"CityBuilder.tsx",hint:"左键建造，R / 右键旋转，Delete 拆除，Z / Y 撤销重做，WASD 平移。建筑类型：住宅 A / B / C、车库、树林、道路。",accent:"#7edeb8",actions:[{key:"undo",label:"↶ 撤销"},{key:"redo",label:"↷ 重做"},{key:"demolish",label:"拆除"},{key:"save",label:"导出 JSON"},{key:"load",label:"导入 JSON"}],controls:[
    {key:"building",label:"建筑类型",min:0,max:5,step:1,value:0},{key:"grid",label:"城市范围",min:10,max:18,step:2,value:12},{key:"zoom",label:"视野大小",min:10,max:26,step:.5,value:18},{key:"angle",label:"环绕视角",min:0,max:6.28,step:.05,value:.7},
  ]},
  {id:"destruction",name:"物理破坏场",subtitle:"SHATTER / IMPULSE / RESET",file:"DestructionLab.tsx",hint:"点击方块单独击碎，空格全部爆破，R 复位。所有碎片均使用真实凸碰撞体与刚体。",accent:"#e4a0ed",actions:[{key:"explode",label:"✦ 全部爆破"},{key:"reset",label:"↺ 重建方块"}],controls:[
    {key:"power",label:"爆破冲量",min:.5,max:7,step:.25,value:3},{key:"gravity",label:"重力倍率",min:.1,max:2,step:.1,value:1},
  ]},
  {id:"racing",name:"微型赛车",subtitle:"DRIVE / CORNER / LAP",file:"Racing.tsx",hint:"点击画面，WASD / 方向键驾驶，空格刹车，R 回到起点。依次通过四个弯道计圈。",accent:"#ffac86",actions:[{key:"reset",label:"↺ 返回起点"}],controls:[
    {key:"acceleration",label:"加速推力",min:8,max:40,step:1,value:22},{key:"speed",label:"最高速度",min:5,max:22,step:.5,value:13},{key:"steering",label:"转向灵敏度",min:.6,max:3.5,step:.1,value:1.8},
  ]},
  {id:"match3",name:"连锁三消",subtitle:"SWAP / MATCH / CASCADE",file:"Match3.tsx",hint:"拖动相邻图块交换；无效交换会回退。三连及以上消除后自动补位，连续消除获得连击。",accent:"#f4c470",actions:[{key:"hint",label:"✧ 提示交换"},{key:"shuffle",label:"↺ 新棋盘"}],controls:[
    {key:"size",label:"棋盘边长",min:6,max:9,step:1,value:8},{key:"types",label:"图块种类",min:3,max:5,step:1,value:5},{key:"seed",label:"随机种子",min:1,max:999,step:1,value:42},{key:"animation",label:"动画速度",min:.5,max:2,step:.1,value:1},
  ]},
  {id:"dungeon",name:"程序地牢",subtitle:"PARTITION / CONNECT / SEED",file:"Dungeon.tsx",hint:"观察 BSP 分区、房间与走廊逐步生成。相同参数和种子可重现相同布局，空格生成下一张。",accent:"#85cddd",actions:[{key:"generate",label:"✧ 生成下一张"}],controls:[
    {key:"size",label:"地图边长",min:18,max:40,step:1,value:26},{key:"room",label:"最小分区",min:3,max:8,step:1,value:5},{key:"seed",label:"随机种子",min:1,max:999,step:1,value:17},{key:"speed",label:"生成速度",min:1,max:30,step:1,value:8},
  ]},
] as const;
