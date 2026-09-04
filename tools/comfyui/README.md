# ComfyUI note

The compose file intentionally flags its image as a placeholder. Validate the current
ComfyUI ROCm image against Ryzen AI Max+ 395 before making it your default.

For this APU, the important environment is generally:
- /dev/kfd
- /dev/dri
- HSA_OVERRIDE_GFX_VERSION=11.5.1
- HIP_VISIBLE_DEVICES=0

If the chosen image uses a different path or startup command, edit only this folder.
