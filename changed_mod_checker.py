# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///
from __future__ import annotations
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from zipfile import ZipFile
import tomllib
import re
import shutil
import argparse

INDENT = " " * 4


@dataclass(frozen=True)
class ModInfo:
    modid: str
    name: str = field(compare=False)
    full_path: Path = field(compare=False)


def check_modpack_dir(pack: Path, check_options_cfg: bool = True) -> bool:
    ret = True
    if not pack.exists():
        print(f"整合包不存在 {pack.absolute()}")
        ret = False

    if not (pack / "mods").exists():
        print(f"整合包格式错误: 不存在mods文件夹 {pack.absolute()}")
        ret = False

    if not (pack / "config").exists():
        print(f"整合包格式错误: 不存在config文件夹 {pack.absolute()}")
        ret = False

    if not (pack / "options.txt").exists() and check_options_cfg:
        print(f"整合包格式错误: 不存在options.txt {pack.absolute()}")
        ret = False

    return ret


def get_modid_from_filename(filename: str) -> str:
    raw = filename
    raw = re.sub(r"[\[【].*?[\]】]", "", raw).strip().lower()
    raw = raw.replace(" ", "-")
    ret = re.split(
        r"[-_\s+](?:neoforge|forge|fabric|(?:mc|v|a|b|alpha|beta|version)?\d+\.\d+)",
        raw,
    )[0]
    return ret


def get_modid(file: Path) -> str:
    metadata = ["neoforge.mods.toml", "mods.toml"]
    with ZipFile(file) as zip_:
        for m in metadata:
            try:
                with zip_.open(f"META-INF/{m}", mode="r") as f:
                    data = tomllib.load(f)
                    mod_id = data["mods"][0]["modId"]
                    return mod_id
            except KeyError:
                continue
                # print(f"Warning: modid解析失败, 模组:{file.name}")
            except (ValueError, tomllib.TOMLDecodeError) as e:
                print(e)
    return get_modid_from_filename(file.stem)


def get_modinfo(mods_dir: Path) -> set[ModInfo]:
    return {
        ModInfo(get_modid(f), f.name, f.absolute())
        for f in mods_dir.iterdir()
        if f.is_file() and f.suffix == ".jar"
    }


def build_diff_text(old: set[ModInfo], new: set[ModInfo]) -> str:
    updated_or_added = sorted(new - old, key=lambda x: x.name.lower())
    removed_or_customized = sorted(old - new, key=lambda x: x.name.lower())

    text: list[str] = ["只在新整合包中出现的mod(一般是更新或新增的模组):"]
    # TODO: 修复diff文本在无差别时的bug
    text.extend(
        f"{INDENT}{x.name}" if len(updated_or_added) > 0 else f"{INDENT}无"
        for x in updated_or_added
    )
    text.append("")
    text.append("只在旧整合包中出现的mod(一般是被删除, 被更新或自行添加的模组):")
    text.extend(
        f"{INDENT}{x.name}" if len(removed_or_customized) > 0 else f"{INDENT}无"
        for x in removed_or_customized
    )
    return "\n".join(text)


def build_debug_text(
    old: Iterable[ModInfo], new: Iterable[ModInfo], old_modpack: Path, new_modpack: Path
) -> str:
    old = sorted(old, key=lambda x: x.name.lower())
    new = sorted(new, key=lambda x: x.name.lower())
    text = ["\n\ndebug:"]
    text.append(f"{INDENT}old ('{old_modpack}'): ")
    text.extend(f"{INDENT * 2}name: {x.name}, modid: {x.modid}" for x in old)
    text.append("\n")  # 2空行
    text.append(f"{INDENT}new ('{new_modpack}'): ")
    text.extend(f"{INDENT * 2}name: {x.name}, modid: {x.modid}" for x in new)
    text.append("-")
    return "\n".join(text)


def move_files(
    new_modpack: Path,
    old_modpack: Path,
    mods: Iterable[ModInfo],
    configs: Iterable[Path],
) -> None:
    option_o = old_modpack / "options.txt"

    if option_o.exists():
        shutil.copy(option_o, new_modpack)

    saves = old_modpack / "saves"
    if saves.exists():
        shutil.copytree(saves, new_modpack / "saves", dirs_exist_ok=True)

    screenshots = old_modpack / "screenshots"
    if screenshots.exists():
        shutil.copytree(screenshots, new_modpack / "screenshots", dirs_exist_ok=True)

    res_pack = old_modpack / "resourcepacks"
    if res_pack.exists():
        shutil.copytree(res_pack, new_modpack / "resourcepacks", dirs_exist_ok=True)

    xaero = old_modpack / "xaero"
    if xaero.exists():
        shutil.copytree(xaero, new_modpack / "xaero", dirs_exist_ok=True)

    mod_dst = new_modpack / "mods"
    for info in mods:
        shutil.copy(info.full_path, mod_dst)

    cfg_dst = new_modpack / "config"
    for cfg in configs:
        if cfg.is_file():
            shutil.copy(cfg, cfg_dst)
        elif cfg.is_dir():
            shutil.copytree(cfg, cfg_dst / cfg.name, dirs_exist_ok=True)
        else:
            raise ValueError(f"不支持的路径类型: {cfg}")


def search_configs(old_modpack: Path, mods: Iterable[ModInfo]) -> set[Path]:
    # 非常sb的实现, 但是我没招了
    specific_id_mapping: dict["str", str | list[str]] = {
        "tweakerge": "tweakeroo",
        "xaerominimap": "xaero",
        "xaeroworldmap": "xaero",
    }
    ret: list[Path] = []
    for cfg in (old_modpack / "config").iterdir():
        cfg_name = get_modid_from_filename(cfg.stem)
        for mod_info in mods:
            modid = mod_info.modid
            if (
                cfg_name == modid
                or cfg_name in modid
                or modid in cfg_name
                or specific_id_mapping.get(modid, "") == cfg_name
            ):
                ret.append(cfg.absolute())
    return set(ret)


def confirm(prompt: str) -> bool:
    return input(prompt).lower() == "y"


def show_chosen_files(
    old_modpack: Path, mods: Iterable[ModInfo], configs: Iterable[Path]
):
    print("\n----------分割线-----------\n")
    print(f'即将迁移该整合包下的文件: "{old_modpack}"')
    print("包括小地图文件, 截图, 资源包和存档")
    if (old_modpack / "xaero").exists():
        print("已发现xaero地图文件")
    print("模组:")
    text = [f"{INDENT}{Path(*x.full_path.parts[-2:])}" for x in mods]
    print("\n".join(text) if len(text) > 0 else f"{INDENT}无待迁移模组")
    print("配置文件:")
    print(f"{INDENT}options.txt")
    for x in configs:
        print(f"{INDENT}{Path(*x.parts[-2:])}")
    print(
        "注意!!只迁移旧版本有而新版本没有的模组, 请自动检查是否迁移错误或迁移了被删掉的模组"
    )


def cli_init() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="比较新旧整合包的模组差异，并可自动迁移旧包的配置和额外模组。\n",
        epilog=(
            "整合包路径格式:\n"
            "    未开启版本隔离 → .minecraft 目录\n"
            "    开启版本隔离   → .minecraft/versions/<整合包名称>"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("oldpack", help="旧整合包路径(格式见说明)")
    parser.add_argument("newpack", help="新整合包路径(格式见说明)")
    parser.add_argument(
        "-a",
        "--auto-move",
        action="store_true",
        help="自动迁移旧包中独有的模组及对应的配置文件（options.txt 和 config 中的相关文件）",
    )
    parser.add_argument(
        "-d",
        "--debug",
        action="store_true",
        help="在 diff.txt 中输出所有检测到的模组详细信息（用于调试）",
    )
    return parser.parse_args()


def main() -> None:
    args = cli_init()
    older_pack: Path = Path(args.oldpack)
    newer_pack: Path = Path(args.newpack)
    debug = args.debug
    auto_move = args.auto_move

    if not check_modpack_dir(older_pack):
        return

    if not check_modpack_dir(newer_pack, False):
        return

    o, n = get_modinfo(older_pack / "mods"), get_modinfo(newer_pack / "mods")

    diff = build_diff_text(o, n)
    with open("diff.txt", mode="w", encoding="utf-8") as f:
        f.write(diff)
        if debug:
            f.write(build_debug_text(o, n, older_pack, newer_pack))
    print(diff)

    if not auto_move:
        print("未启用自动迁移，仅输出差异到 diff.txt")
        return

    if not confirm(
        "是否自动迁移只在旧整合包内出现模组, options.txt和对应配置文件? (y/n) "
    ):
        print("不进行整合包迁移, 仅输出差异到 diff.txt")
        return

    customized = sorted(o - n, key=lambda x: x.name.lower())
    configs = search_configs(older_pack, customized)
    show_chosen_files(older_pack, customized, configs)

    if not confirm("警告: 自动匹配很可能错选漏选配置文件, 请自行核对! 是否迁移? (y/n)"):
        print("不进行整合包迁移, 仅输出差异到 diff.txt")
        return

    move_files(newer_pack, older_pack, customized, configs)  # 最后再取消注释

    print("Done!")


if __name__ == "__main__":
    main()
