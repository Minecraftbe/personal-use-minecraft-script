/* 
    此程序未写好, 即使是目前的逻辑(ActionGroup预设)也有问题
    预设是小问题, 重要的是目前有两个麻烦的东西
    1.塔吊状态的持久化, 使得在存读档的时候仍然可以正常运作
    2.机械动力黏着器的黏着状态未知, 这个可能重要可能不重要, 但是很令人恶心
    -----------------------------------------------
    不过如果我们用一堆状态, 并且序列化与反序列化Crane实例, 或许极大概率能解决上述问题
    尤其是黏着器问题, 在被放下后用一个影子状态来记录其状态
    如果序列化和反序列化正常工作, 并且无玩家和额外因素手动改变现实黏着器状态, 那么影子黏着器状态极大概率和现实同步
    虽然不够健壮, 但是我认为这是目前可行且较简单的解决办法
    从事实上来讲, 如果Crane类的问题得到解决, 那么该脚本将有足够资格成为我未来操控机器的cc-tstl脚本的范本甚至蓝图
    TODO: 为Crane类添加持久化, 创建大量内部状态
*/

import * as event from "./event";

const LogLevel = {
    CRITICAL: 0,
    ERROR: 10,
    WARN: 20,
    INFO: 30,
    DEBUG: 40
} as const

const LOG_LEVEL = LogLevel.DEBUG

const logger = {
    _log(level: number, msg: string) { if (level <= LOG_LEVEL) print(msg) },
    _formatter(prefix: string, msg: string) { return `[${prefix}] ${msg}` },
    debug(msg: string) { logger._log(LogLevel.DEBUG, logger._formatter("DEBUG", msg)) },
    info(msg: string) { logger._log(LogLevel.INFO, logger._formatter("INFO", msg)) },
    warn(msg: string) { logger._log(LogLevel.WARN, logger._formatter("WARN", msg)) },
    error(msg: string) { logger._log(LogLevel.ERROR, logger._formatter("ERROR", msg)) },
    critical(msg: string) { logger._log(LogLevel.CRITICAL, logger._formatter("CRITICAL", msg)) },
} as const

enum CraneState {
    unloading,
    loading,
    idle
}

const craneStateString = ["unloading", "loading", "idle"]

interface CraneAction {
    displayName?: string
    action: () => void
    condition?: () => boolean
    end?: () => void
    timeout?: number
}

/**
 * 操控对集束线缆的输出。在手动set或者reset之前, 对应颜色线缆状态保持不变, 即对16种颜色的自动状态管理。
 * 简化cc电脑对集束线缆(如ProjectRed集束线缆)仅想单独为某颜色设置输出时, 仍然要输入其他颜色掩码并combine或subtract的过程
 * 
 * 如果研究过cc redstone.setBundledOutput和颜色机制就明白我在说什么以及这个类做了什么
 */
class ColorManager {
    private outputBuf = 0
    constructor(public side: string) {
        this.outputBuf = redstone.getBundledOutput(side)
    }

    // 输出相关

    public set(color: Color): void {
        this.outputBuf = colors.combine(this.outputBuf, color)
        redstone.setBundledOutput(this.side, this.outputBuf)
    }

    /**用来检查某颜色是否在设定的电脑输出中
     * 
     * @param color 颜色掩码
     * @returns 
     */
    public isOutputting(color: Color): boolean {
        return colors.test(this.outputBuf, color)
    }

    public reset(color: Color): void {
        this.outputBuf = colors.subtract(this.outputBuf, color)
        redstone.setBundledOutput(this.side, this.outputBuf)
    }

    public resetAll(): void {
        this.outputBuf = 0
        redstone.setBundledOutput(this.side, this.outputBuf)
    }

    public setAll(): void {
        this.outputBuf = 0xFFFF
        redstone.setBundledOutput(this.side, this.outputBuf)
    }

    // 线缆输入相关, 通常是输出的超集, 因此我个人认为分开是明智的选择
    // 从我把这个类的input和output分开之后, 才体会到cc redstone api设计的精妙

    /**用来检查某颜色是否在线缆输入中, 运行逻辑同colors.test(), 即检查输入的颜色掩码是否全部包含在被测试的输入中
     * 
     * @param color 颜色掩码
     * @returns 
     */
    public isInputOn(color: Color): boolean {
        return colors.test(redstone.getBundledInput(this.side), color)
    }

    /**
     * 用来检查输入的多个颜色掩码是否至少有一个包含在被测试的输入中
     * 
     * 此方法并不能阻止输入组合过的颜色掩码, 但使用时尽量传入多个颜色掩码而不是combine为一个掩码, 否则该方法失去意义
     */
    public isAnyInputOn(...colors_: Color[]) {
        const input = redstone.getBundledInput(this.side)
        for (const color of colors_) {
            if (colors.test(input, color)) return true
        }
        return false
    }

    public getOutputs(): Color {
        return this.outputBuf
    }

    public pulse(color: Color): void {
        this.set(color)
        sleep(0.1) // 2gt, 1rt
        this.reset(color)
    }
}


class Crane {
    private currentState: CraneState = CraneState.idle

    constructor(
        public actionGroup: Record<CraneState, CraneAction[]>,
        private transitions: Partial<Record<CraneState, CraneState>>,
        private runningCondition: () => boolean,// 在何时启动流程, 例如火车到站时
        public waitAfterAction: number = 0.05
    ) { }

    private update(): void {
        const stateName = craneStateString[this.currentState]

        for (const action of this.actionGroup[this.currentState]) {
            logger.debug("Executing action: " + action.displayName)

            action.action()

            // 和llm交流是对的, 我自己想不出来这里有可能会有执行延迟导致空轮询, 所以干脆先停一小会
            if (this.waitAfterAction > 0) {
                sleep(this.waitAfterAction)
            }

            const timeoutSec = action.timeout ?? 20
            const timerID = os.startTimer(timeoutSec)
            while (!(action.condition?.() ?? true)) {
                const ev = event.pullEvent()
                const name = ev.get_name()
                if (name === "timer" && (ev as event.TimerEvent).id === timerID) {
                    throw `Timeout in <${stateName}> during "${action.displayName}"`
                };
            }
            os.cancelTimer(timerID)
            action.end?.()
        }
        this.currentState = this.transitions[this.currentState] ?? CraneState.idle // 如果没定义下一步动作则自动复位
    }

    public run(): void {
        while (true) {
            // 这代表着会先执行一遍idle流程, 通常情况下意味着复位
            const prevState = this.currentState
            this.update()
            logger.info("Transitioned to: " + craneStateString[this.currentState])
            if (prevState === CraneState.idle) {
                logger.info("System Idle. Waiting for running conditions (Train docked & Yard clear)...")
                while (!this.runningCondition()) event.pullEventAs(event.RedstoneEvent);
                logger.info("Conditions met! Starting crane sequence.")
            }
        }
    }

    public reset(): void {
        this.currentState = CraneState.idle
        this.update()
    }
}
// 吊臂传感器: 白色: 卸货区位传感器, 淡蓝色: 装货区位传感器, 红色: 火车货车位传感器, 粉色: 吊钩位集装箱探测器, 用于检查钩子是否正常运作
// 货场传感器: 蓝色: 卸货区传感器, 是否有箱, 橙色: 装货区传感器, 是否有箱
// 火车控制: 黄绿色: 装卸流程是否完毕, 火车是否可启动信号    火车传感器: 绿色: 火车靠站传感器
// 吊臂-起升机构控制: 灰色: 起重机吊钩(黏着器), 淡灰色: 反转起升机构运动方向, 紫色: 反转吊臂运动方向, 黄色: 吊臂停止,起升机构运作
// 警告: 粉红色
const SENSOR = {
    // 吊臂位置
    CRANE_AT_UNLOAD: colors.white,     // 卸货区位传感器
    CRANE_AT_LOAD: colors.lightBlue,   // 装货区位传感器
    CRANE_AT_TRAIN: colors.red,        // 火车货车位传感器
    HOOK_WORKING: colors.pink,

    TRAIN_DOCKED: colors.green,        // 火车已靠站(到位)
    YARD_UNLOAD_OCCUPIED: colors.blue, // 卸货区传感器, 是否有箱
    YARD_LOAD_OCCUPIED: colors.orange  // 装货区传感器, 是否有箱
} as const

const ACTUATOR = {
    TRAIN_READY: colors.lime,          // 火车控制: 装卸流程是否完毕

    ARM_STOP: colors.yellow,           // 吊臂停止, 同时起升机构运作
    ARM_REVERSE: colors.purple,        // 吊臂运动方向反转

    HOOK_TOGGLE: colors.gray,          // 起重机吊钩(黏着器)控制
    LIFT_REVERSE: colors.lightGray,    // 起升机构运动方向反转
    LIFT_STOP: colors.cyan,            // 起升机构离合
} as const

const WARNING = {
    WARN: colors.magenta
} as const


/**注意此预设里面的各种执行器状态实际上和硬件状态紧耦合, 例如ARM_REVERSE实际上在此预设中意味着大臂收回而非单纯反转
 * 
 * @param cm 
 * @returns 
 */

// 此预设的假设: 
// 当ARM_REVERSE set时, 大臂向内收 当LIFT_REVERSE set时, 升降机上升
function completePreset(cm: ColorManager): [
    Record<CraneState, CraneAction[]>,
    Partial<Record<CraneState, CraneState>>,
    () => boolean
] {
    const liftCargo = {
        displayName: "Lift Hook",
        action() { cm.set(ACTUATOR.LIFT_REVERSE) },
        condition() { return cm.isInputOn(SENSOR.HOOK_WORKING) }
    }
    const lowerAndLatch = {
        displayName: "Lower and Latch Hook",
        action() { cm.reset(ACTUATOR.LIFT_REVERSE) },
        condition() { return cm.isInputOn(SENSOR.HOOK_WORKING) },
        end() { cm.pulse(ACTUATOR.HOOK_TOGGLE) },
    }
    // FIXME: 修复这里的运行逻辑错误
    const actionGroup: Record<CraneState, CraneAction[]> = {
        [CraneState.idle]: [
            {
                displayName: "Attempt Hook Lift",
                action() {
                    if (!cm.isOutputting(ACTUATOR.ARM_STOP)) {
                        cm.set(ACTUATOR.ARM_STOP)
                    }
                    if (cm.isInputOn(SENSOR.HOOK_WORKING)) {
                        cm.pulse(ACTUATOR.HOOK_TOGGLE)
                    }
                    cm.set(ACTUATOR.LIFT_REVERSE)
                },
                condition() { sleep(3); return true }
            },
            {
                displayName: "Release Check and Raise",
                action() {
                    if (cm.isInputOn(SENSOR.HOOK_WORKING)) {
                        cm.reset(ACTUATOR.LIFT_REVERSE)
                        sleep(3)
                        cm.pulse(ACTUATOR.HOOK_TOGGLE)
                    }
                    cm.set(ACTUATOR.LIFT_REVERSE)
                },
                condition() { sleep(13); return true },
                end() { cm.reset(ACTUATOR.ARM_STOP) },
            },
            {
                displayName: "Reset Main Arm",
                action() { cm.set(ACTUATOR.ARM_REVERSE) },
                condition() { sleep(13); return true },
            }
        ],
        [CraneState.loading]: [
            {
                displayName: "Move Arm to Loading Area",
                action() { cm.reset(ACTUATOR.ARM_STOP); cm.reset(ACTUATOR.ARM_REVERSE) },
                condition() { return cm.isInputOn(SENSOR.CRANE_AT_LOAD) },
                end() { cm.set(ACTUATOR.ARM_STOP) }
            },
            lowerAndLatch,
            liftCargo,
            {
                displayName: "Move Arm to Train Carriage",
                action() { cm.reset(ACTUATOR.ARM_STOP) },
                condition() { return cm.isInputOn(SENSOR.CRANE_AT_TRAIN) },
            },
            {
                displayName: "Lower Hook and Unload",
                action() { cm.reset(ACTUATOR.LIFT_REVERSE) },
                condition() { return cm.isInputOn(SENSOR.HOOK_WORKING) },
                end() { cm.set(ACTUATOR.HOOK_TOGGLE) }
            },
            {
                displayName: "Lift Hook",
                action() { cm.set(ACTUATOR.LIFT_REVERSE) },
                condition() { sleep(13); return true }
            }
        ],
        [CraneState.unloading]: [
            {
                displayName: "Move Arm Above Train",
                action() { cm.reset(ACTUATOR.ARM_REVERSE) },
                condition() { return cm.isInputOn(SENSOR.CRANE_AT_TRAIN) },
                end() { cm.set(ACTUATOR.ARM_STOP) },
            },
            lowerAndLatch,
            liftCargo,
            {
                displayName: "Move Arm to Unloading Area",
                action() { cm.set(ACTUATOR.ARM_REVERSE) },
                condition() { return cm.isInputOn(SENSOR.CRANE_AT_UNLOAD) },
                end() { cm.set(ACTUATOR.ARM_STOP) }
            },
            {
                displayName: "Lower Hook and Unload",
                action() { cm.reset(ACTUATOR.LIFT_REVERSE) },
                condition() { return cm.isInputOn(SENSOR.YARD_UNLOAD_OCCUPIED) },
                end() { cm.set(ACTUATOR.HOOK_TOGGLE) }
            },
            {
                displayName: "Lift Hook",
                action() { cm.set(ACTUATOR.LIFT_REVERSE) },
                condition() { sleep(13); return true }
            },
            {
                displayName: "Notify Train",
                action() { cm.set(ACTUATOR.TRAIN_READY) }
            }
        ]
    }
    const transitions = {
        [CraneState.idle]: CraneState.unloading,
        [CraneState.unloading]: CraneState.loading,
        [CraneState.loading]: CraneState.idle
    }
    const runningCondition = () => {
        return cm.isInputOn(SENSOR.TRAIN_DOCKED)
            && !cm.isInputOn(SENSOR.YARD_UNLOAD_OCCUPIED)
    }
    return [actionGroup, transitions, runningCondition]
}

function main() {
    const cm = new ColorManager("right")
    cm.reset(WARNING.WARN)
    const crane = new Crane(...completePreset(cm));

    logger.info("Crane Control System Initialized.");

    try {
        crane.run();
    } catch (e) {
        const errorMsg = typeof e === "string" ? e : tostring(e);
        const lowerMsg = errorMsg.toLowerCase();

        if (lowerMsg.includes("terminate")) {
            logger.warn("Termination signal received. Safely stopping...");
        } else if (lowerMsg.includes("timeout")) {
            logger.error("Operation Timeout: " + errorMsg);
            cm.set(WARNING.WARN);
        } else {
            cm.set(WARNING.WARN);
            logger.error("System Panic: " + errorMsg);
        }

    } finally {
        logger.info("Starting emergency reset sequence...");
        try {
            crane.reset();
            logger.info("Hardware reset successful. System offline.");
        } catch (resetError) {
            logger.critical("Critical: Failed to reset hardware!");
        }
    }
}

main()