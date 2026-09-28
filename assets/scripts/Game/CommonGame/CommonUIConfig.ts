import { UIDataRegistry, UILayer, UIShowMode } from '../../engine/ui/UIData';

export enum CommonBundleName {
    Resources = 'resources',
    Game = 'game',
    Rank = 'rank',
}

/**
 * 通用 UI ID 枚举
 */
export enum CommonUIID {
    None = 0,
    LoadingPanel = 1,
    MainPanel = 2,
    GamePanel = 3,
    RankPanel = 4,
    LoginPanel = 5,
    PausePanel = 6,
    TransitionPanel = 7,
    AdPanel = 8,
    SkillPanel = 9,
}

/**
 * 注册通用 UI 面板到框架
 */
export function registerCommonGameUI(): void {
    UIDataRegistry.Register(CommonUIID.LoadingPanel, UILayer.System, "LoadingPanel", "ui/LoadingPanel");
    UIDataRegistry.Register(CommonUIID.MainPanel, UILayer.Normal, "MainPanel", "ui/MainPanel", UIShowMode.Normal, 1);
    UIDataRegistry.Register(CommonUIID.GamePanel, UILayer.Normal, "GamePanel", "ui/GamePanel", UIShowMode.Normal, 1, CommonBundleName.Game);
    UIDataRegistry.Register(CommonUIID.RankPanel, UILayer.PopUp, "RankPanel", "ui/RankPanel", UIShowMode.Normal, 1, CommonBundleName.Rank);
    UIDataRegistry.Register(CommonUIID.LoginPanel, UILayer.Normal, "LoginPanel", "ui/LoginPanel", UIShowMode.Normal, 1);
    UIDataRegistry.Register(CommonUIID.PausePanel, UILayer.PopUp, "PausePanel", "ui/PausePanel", UIShowMode.Normal, 1, CommonBundleName.Game);
    UIDataRegistry.Register(CommonUIID.TransitionPanel, UILayer.TopMost, "TransitionPanel", "ui/TransitionPanel", UIShowMode.Normal, 0, CommonBundleName.Game);
    UIDataRegistry.Register(CommonUIID.AdPanel, UILayer.PopUp, "AdPanel", "ui/AdPanel", UIShowMode.Normal, 1, CommonBundleName.Game);
    // 升级选技能。PopUp 层才能盖住 Normal 层的 GamePanel；
    // cacheCount = 1 = 关闭时只隐藏、下次复用，所以状态必须在 OnOpen 里复位
    UIDataRegistry.Register(CommonUIID.SkillPanel, UILayer.PopUp, "SkillPanel", "ui/SkillPanel", UIShowMode.Normal, 1, CommonBundleName.Game);
}
