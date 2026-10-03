/**
 * 局内弹出层：天赋三选一 / 升级三选一 / 结算
 *
 * 为什么用 Graphics 而不是美术：这些弹层是玩法框架的一部分，
 * 现阶段没有卡片素材（现有 fanpai/diban 是上一版玩法的残留），
 * 用 Graphics 画底 + Label 写文案，零素材依赖，正式 UI 再换 prefab。
 */

import { BlockInputEvents, Button, Color, Graphics, Label, Node, UITransform, Vec3 } from 'cc';
import { GameTuning } from '../core/GameTuning';
import { createLabel, makeNode } from './GameArt';

/** 一个可点选项 */
export interface OverlayOption {
    title: string;
    desc?: string;
}

export interface OverlayHandle {
    node: Node;
    /** 关掉弹层 */
    close(): void;
}

const CARD_WIDTH = 520;
const CARD_HEIGHT = 132;
const CARD_GAP = 18;

/** 半透明遮罩（同时吃掉面板节点的触摸事件） */
function createBackdrop(parent: Node): Node {
    const backdrop = makeNode(parent, 'OverlayBackdrop');
    const transform = backdrop.addComponent(UITransform);
    transform.setContentSize(GameTuning.designWidth, GameTuning.designHeight);

    const graphics = backdrop.addComponent(Graphics);
    graphics.fillColor = new Color(0, 0, 0, 190);
    graphics.rect(-GameTuning.designWidth / 2, -GameTuning.designHeight / 2, GameTuning.designWidth, GameTuning.designHeight);
    graphics.fill();

    // 阻止点击穿透到下层 UI（§注意：全局 input 监听不受此影响，玩法层自己用 paused 拦）
    backdrop.addComponent(BlockInputEvents);
    return backdrop;
}

/** 画一张卡片底（返回卡片节点） */
function createCard(parent: Node, index: number, option: OverlayOption, startY: number, onPick: (index: number) => void): Node {
    const y = startY - index * (CARD_HEIGHT + CARD_GAP);
    const card = makeNode(parent, `Card_${index}`);
    card.setPosition(new Vec3(0, y, 0));

    const transform = card.addComponent(UITransform);
    transform.setContentSize(CARD_WIDTH, CARD_HEIGHT);

    const graphics = card.addComponent(Graphics);
    graphics.fillColor = new Color(38, 42, 58, 245);
    graphics.roundRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 16);
    graphics.fill();
    graphics.strokeColor = new Color(120, 190, 255, 255);
    graphics.lineWidth = 3;
    graphics.roundRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 16);
    graphics.stroke();

    const title: Label = createLabel(card, 'Title', option.title, 30, new Color(255, 255, 255, 255));
    title.node.setPosition(new Vec3(0, option.desc ? 22 : 0, 0));

    if (option.desc) {
        const desc: Label = createLabel(card, 'Desc', option.desc, 22, new Color(190, 200, 220, 255));
        desc.node.setPosition(new Vec3(0, -24, 0));
    }

    const button = card.addComponent(Button);
    button.transition = Button.Transition.NONE;
    card.on(Button.EventType.CLICK, () => onPick(index));
    return card;
}

/**
 * 弹出选择层（点选项才算数，不可取消）
 * @param title 顶部标题
 * @param options 选项列表（通常 3 个）
 * @param onPick 选中回调，参数是下标
 */
export function showChoiceOverlay(
    parent: Node,
    title: string,
    options: OverlayOption[],
    onPick: (index: number) => void
): OverlayHandle {
    const root = createBackdrop(parent);

    const titleLabel: Label = createLabel(root, 'Title', title, 34, new Color(255, 236, 160, 255));
    titleLabel.node.setPosition(new Vec3(0, 330, 0));

    const total = options.length;
    const startY = ((total - 1) * (CARD_HEIGHT + CARD_GAP)) / 2 - 40;

    const handle: OverlayHandle = {
        node: root,
        close(): void {
            if (root && root.isValid) root.destroy();
        },
    };

    options.forEach((option, index) => {
        createCard(root, index, option, startY, picked => {
            handle.close();
            onPick(picked);
        });
    });

    return handle;
}

/**
 * 弹出一个纯提示层（结算、过关用）
 * @param buttons 按钮文案，点哪个回调哪个下标
 */
export function showMessageOverlay(
    parent: Node,
    title: string,
    message: string,
    buttons: string[],
    onPick: (index: number) => void
): OverlayHandle {
    const root = createBackdrop(parent);

    const titleLabel: Label = createLabel(root, 'Title', title, 40, new Color(255, 236, 160, 255));
    titleLabel.node.setPosition(new Vec3(0, 220, 0));

    const messageLabel: Label = createLabel(root, 'Message', message, 24, new Color(220, 226, 240, 255));
    messageLabel.node.setPosition(new Vec3(0, 120, 0));

    const handle: OverlayHandle = {
        node: root,
        close(): void {
            if (root && root.isValid) root.destroy();
        },
    };

    const buttonHeight = 96;
    const startY = 10;
    buttons.forEach((text, index) => {
        const y = startY - index * (buttonHeight + 16);
        const node = makeNode(root, `Button_${index}`);
        node.setPosition(new Vec3(0, y, 0));

        const transform = node.addComponent(UITransform);
        transform.setContentSize(360, buttonHeight);

        const graphics = node.addComponent(Graphics);
        graphics.fillColor = new Color(52, 96, 160, 250);
        graphics.roundRect(-180, -buttonHeight / 2, 360, buttonHeight, 14);
        graphics.fill();

        const label: Label = createLabel(node, 'Text', text, 30, Color.WHITE);

        const button = node.addComponent(Button);
        button.transition = Button.Transition.NONE;
        node.on(Button.EventType.CLICK, () => {
            handle.close();
            onPick(index);
        });
    });

    return handle;
}