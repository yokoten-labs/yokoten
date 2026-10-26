Fixed

The reviewer App has room to finish its answer on a large pull request. At 32K tokens its reasoning used up the room before the verdict; the cap is now 64K. It now waits up to 8 minutes for DeepSeek instead of 4, still inside the review job's 10.
