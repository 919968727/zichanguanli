import platform

def check():
    print('正在检查当前平台...')
    system = platform.system()
    if system == "Windows":
        print("当前平台是 Windows\n")
    elif system == "Linux":
        print("当前平台是 Linux\n")
    else:
        print(f"其他平台: {system}")